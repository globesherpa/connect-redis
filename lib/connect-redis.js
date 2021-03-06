/*!
 * Connect - Redis
 * Copyright(c) 2012 TJ Holowaychuk <tj@vision-media.ca>
 * MIT Licensed
 */

var statsd = require('node-statsd');
var statsdClient = new statsd();
var debug = require('debug')('connect:redis');
var redis = require('redis');
var default_port = 6379;
var default_host = '127.0.0.1';
var noop = function(){};

/**
 * One day in seconds.
 */

var oneDay = 86400;

function getTTL(store, sess) {
  var maxAge = sess.cookie.maxAge;
  return store.ttl || (typeof maxAge === 'number'
    ? Math.floor(maxAge / 1000)
    : oneDay);
}

/**
 * Return the `RedisStore` extending `express`'s session Store.
 *
 * @param {object} express session
 * @return {Function}
 * @api public
 */

module.exports = function (session) {

  /**
   * Express's session Store.
   */

  var Store = session.Store;

  /**
   * Initialize RedisStore with the given `options`.
   *
   * @param {Object} options
   * @api public
   */

  function RedisStore (options) {
    if (!(this instanceof RedisStore)) {
      throw new TypeError('Cannot call RedisStore constructor as a function');
    }

    var self = this;

    options = options || {};
    options.max_attempts = 2;
    Store.call(this, options);
    this.prefix = options.prefix == null
      ? 'sess:'
      : options.prefix;

    this.serializer = options.serializer || JSON;

    /* istanbul ignore next */
    if (options.url) {
      options.port = options.url;
      options.host = options;
    }

    // convert to redis connect params
    if (options.client) {
      this.client = options.client;
    }
    else if (options.socket) {
      this.client = redis.createClient(options.socket, options);
    }
    else if (options.port || options.host) {
      this.client = redis.createClient(
        options.port || default_port,
        options.host || default_host,
        options
      );
    }
    else {
      this.client = redis.createClient(options);
    }

    if (options.pass) {
      this.client.auth(options.pass, function (err) {
        if (err) {
          throw err;
        }
      });
    }

    this.ttl = options.ttl;
    this.disableTTL = options.disableTTL;

    if (options.unref) this.client.unref();

    if ('db' in options) {
      if (typeof options.db !== 'number') {
        console.error('Warning: connect-redis expects a number for the "db" option');
      }

      self.client.select(options.db);
      self.client.on('connect', function () {
        self.client.select(options.db);
      });
    }

    self.client.on('error', function (er) {
      debug('Redis returned err', er);
      self.emit('disconnect', er);
    });

    self.client.on('connect', function () {
      self.emit('connect');
    });
  }

  /**
   * Inherit from `Store`.
   */

  RedisStore.prototype.__proto__ = Store.prototype;

  /**
   * Attempt to fetch session by the given `sid`.
   *
   * @param {String} sid
   * @param {Function} fn
   * @api public
   */

  RedisStore.prototype.get = function (sid, fn) {
    var store = this;
    var psid = store.prefix + sid;
    if (!fn) fn = noop;
    debug('GET "%s"', sid);
    var timer = new Date();
    store.client.get(psid, function (er, data) {
      var elapsed = new Date() - timer;
      statsdClient.timing("session.redis.get", elapsed);
      if (er) return fn(er);
      if (!data) return fn();

      var result;
      data = data.toString();
      debug('GOT %s', data);

      try {
        result = store.serializer.parse(data);
      }
      catch (er) {
        return fn(er);
      }
      return fn(null, result);
    });
  };

  /**
   * Commit the given `sess` object associated with the given `sid`.
   *
   * @param {String} sid
   * @param {Session} sess
   * @param {Function} fn
   * @api public
   */

  RedisStore.prototype.set = function (sid, sess, fn) {
    var store = this;
    var psid = store.prefix + sid;
    if (!fn) fn = noop;

    try {
      var jsess = store.serializer.stringify(sess);
    }
    catch (er) {
      return fn(er);
    }

    if (store.disableTTL) {
      debug('SET "%s" %s', sid, jsess);
      var timer = new Date();
      store.client.set(psid, jsess, function (er) {
        var elapsed = new Date() - timer;
        statsdClient.timing("session.redis.set", elapsed);
        if (er) return fn(er);
        debug('SET complete');
        fn.apply(null, arguments);
      });
      return;
    }

    var ttl = getTTL(store, sess);

    debug('SETEX "%s" ttl:%s %s', sid, ttl, jsess);
    timer = new Date();
    store.client.setex(psid, ttl, jsess, function (er) {
      var elapsed = new Date() - timer;
      statsdClient.timing("session.redis.setex", elapsed);
      if (er) return fn(er);
      debug('SETEX complete');
      fn.apply(this, arguments);
    });
  };

  /**
   * Destroy the session associated with the given `sid`.
   *
   * @param {String} sid
   * @api public
   */

  RedisStore.prototype.destroy = function (sid, fn) {
    sid = this.prefix + sid;
    debug('DEL "%s"', sid);
    var timer = new Date();
    this.client.del(sid, function(err, res) {
      var elapsed = new Date() - timer;
      statsdClient.timing("session.redis.del", elapsed);
      fn(err, res);
    });
  };

  /**
   * Refresh the time-to-live for the session with the given `sid`.
   *
   * @param {String} sid
   * @param {Session} sess
   * @param {Function} fn
   * @api public
   */

  RedisStore.prototype.touch = function (sid, sess, fn) {
    var store = this;
    var psid = store.prefix + sid;
    if (!fn) fn = noop;
    if (store.disableTTL) return fn();

    var ttl = getTTL(store, sess);

    debug('EXPIRE "%s" ttl:%s', sid, ttl);
    var timer = new Date();
    store.client.expire(psid, ttl, function (er) {
      var elapsed = new Date() - timer;
      statsdClient.timing("session.redis.expire", elapsed);
      if (er) return fn(er);
      debug('EXPIRE complete');
      fn.apply(this, arguments);
    });
  };

  return RedisStore;
};
