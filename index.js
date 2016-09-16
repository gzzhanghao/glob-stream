'use strict';

var through2 = require('through2');
var Combine = require('ordered-read-streams');
var unique = require('unique-stream');

var glob = require('glob');
var pumpify = require('pumpify');
var resolveGlob = require('to-absolute-glob');
var isNegatedGlob = require('is-negated-glob');
var globParent = require('glob-parent');
var path = require('path');
var extend = require('extend');
var sepRe = (process.platform === 'win32' ? /[\/\\]/ : /\/+/);


var Readable = require('readable-stream').Readable;
var inherits = require('util').inherits;

function GlobStream(ourGlob, negatives, opt) {
  if (!(this instanceof GlobStream)) {
    return new GlobStream(override);
  }

  opt.objectMode = true;
  opt.highWaterMark = 16;

  this._reading = false;
  this.destroyed = false;
  Readable.call(this, opt);

  var self = this;
  var hwm = this._readableState.highWaterMark;

  function resolveNegatives(negative) {
    return resolveGlob(negative, opt);
  }

  var ourOpt = extend({}, opt);
  delete ourOpt.root;

  var ourNegatives = negatives.map(resolveNegatives);
  ourOpt.ignore = ourNegatives;

  // Extract base path from glob
  var basePath = ourOpt.base || getBasePath(ourGlob, opt);

  // Remove path relativity to make globs make sense
  ourGlob = resolveGlob(ourGlob, opt);

  var globber = new glob.Glob(ourGlob, ourOpt);
  this._globber = globber;

  var found = false;

  globber.on('match', function(filepath) {
    console.log(filepath);
    self._globber.pause();
    found = true;
    var obj = {
      cwd: opt.cwd,
      base: basePath,
      path: path.normalize(filepath),
    };

    if (self.destroyed) {
      return; // TODO: destory globber
    }
    if (filepath === null) {
      return self.push(null); // TODO: remove?
    }
    self._reading = false;
    if (self.push(obj)) {
      self._read(hwm);
    }
  });

  globber.once('end', function() {
    if (opt.allowEmpty !== true && !found && globIsSingular(globber)) {
      stream.emit('error',
        new Error('File not found with singular glob: ' + ourGlob));
    }

    self.destroy();
  });
}
inherits(GlobStream, Readable);

GlobStream.prototype._read = function(size) {
  if (this._reading || this.destroyed) {
    return;
  }
  this._reading = true;
  this._globber.resume();
};

GlobStream.prototype.destroy = function(err) {
  if (this.destroyed) {
    return;
  }
  this.destroyed = true;

  var self = this;
  process.nextTick(function() {
    if (err) {
      self.emit('error', err);
    }
    self.emit('close');
  });
};

function globStream(globs, opt) {
  if (!opt) {
    opt = {};
  }

  var ourOpt = extend({}, opt);
  var ignore = ourOpt.ignore;

  if (typeof ourOpt.cwd !== 'string') {
    ourOpt.cwd = process.cwd();
  }
  if (typeof ourOpt.dot !== 'boolean') {
    ourOpt.dot = false;
  }
  if (typeof ourOpt.silent !== 'boolean') {
    ourOpt.silent = true;
  }
  if (typeof ourOpt.nonull !== 'boolean') {
    ourOpt.nonull = false;
  }
  if (typeof ourOpt.cwdbase !== 'boolean') {
    ourOpt.cwdbase = false;
  }
  if (ourOpt.cwdbase) {
    ourOpt.base = ourOpt.cwd;
  }
  // Normalize string `ignore` to array
  if (typeof ignore === 'string') {
    ignore = [ignore];
  }
  // Ensure `ignore` is an array
  if (!Array.isArray(ignore)) {
    ignore = [];
  }

  // Only one glob no need to aggregate
  if (!Array.isArray(globs)) {
    globs = [globs];
  }

  var positives = [];
  var negatives = [];

  globs.forEach(function(globString, index) {
    if (typeof globString !== 'string') {
      throw new Error('Invalid glob at index ' + index);
    }

    var glob = isNegatedGlob(globString);
    var globArray = glob.negated ? negatives : positives;

    globArray.push({
      index: index,
      glob: glob.pattern,
    });
  });

  if (positives.length === 0) {
    throw new Error('Missing positive glob');
  }

  // Only one positive glob no need to aggregate
  if (positives.length === 1) {
    return streamFromPositive(positives[0]);
  }

  // Create all individual streams
  var streams = positives.map(streamFromPositive);

  // Then just pipe them to a single unique stream and return it
  var aggregate = new Combine(streams);
  var uniqueStream = unique('path');

  return pumpify.obj(aggregate, uniqueStream);

  function streamFromPositive(positive) {
    var negativeGlobs = negatives
      .filter(indexGreaterThan(positive.index))
      .map(toGlob)
      .concat(ignore);
    return new GlobStream(positive.glob, negativeGlobs, ourOpt);
  }
}

function createStream(ourGlob, negatives, opt) {
  function resolveNegatives(negative) {
    return resolveGlob(negative, opt);
  }

  var ourOpt = extend({}, opt);
  delete ourOpt.root;

  var ourNegatives = negatives.map(resolveNegatives);
  ourOpt.ignore = ourNegatives;

  // Extract base path from glob
  var basePath = ourOpt.base || getBasePath(ourGlob, opt);

  // Remove path relativity to make globs make sense
  ourGlob = resolveGlob(ourGlob, opt);

  // Create globbing stuff
  var globber = new glob.Glob(ourGlob, ourOpt);

  // Create stream and map events from globber to it
  var stream = through2.obj(ourOpt);

  var found = false;

  globber.on('error', stream.emit.bind(stream, 'error'));
  globber.once('end', function() {
    if (opt.allowEmpty !== true && !found && globIsSingular(globber)) {
      stream.emit('error',
        new Error('File not found with singular glob: ' + ourGlob));
    }

    stream.end();
  });
  globber.on('match', function(filename) {
    found = true;

    stream.write({
      cwd: opt.cwd,
      base: basePath,
      path: path.normalize(filename),
    });
  });
  return stream;
}

function indexGreaterThan(index) {
  return function(obj) {
    return obj.index > index;
  };
}

function toGlob(obj) {
  return obj.glob;
}

function globIsSingular(glob) {
  var globSet = glob.minimatch.set;
  if (globSet.length !== 1) {
    return false;
  }

  return globSet[0].every(function isString(value) {
    return typeof value === 'string';
  });
}

function getBasePath(ourGlob, opt) {
  var basePath;
  var parent = globParent(ourGlob);

  if (parent === '/' && opt && opt.root) {
    basePath = path.normalize(opt.root);
  } else {
    basePath = resolveGlob(parent, opt);
  }

  if (!sepRe.test(basePath.charAt(basePath.length - 1))) {
    basePath += path.sep;
  }
  return basePath;
}

module.exports = globStream;
