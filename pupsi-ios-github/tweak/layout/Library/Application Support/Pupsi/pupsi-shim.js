// pupsi-shim.js - iOS WKWebView bridge for the shared engine.
// Maps the small chrome.* surface used by content.js onto localStorage and
// a local pupsi:// URL scheme served from the app bundle.
(function () {
  'use strict';
  if (typeof window.chrome !== 'undefined') return;

  var PREFIX = 'pupsi:';
  var listeners = [];

  function snapshot() {
    var all = {};
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf(PREFIX) === 0) {
          try { all[k.slice(PREFIX.length)] = JSON.parse(localStorage.getItem(k)); }
          catch (e) { /* ignore corrupt value */ }
        }
      }
    } catch (e) {}
    return all;
  }

  function emit(changes) {
    listeners.slice().forEach(function (fn) {
      try { fn(changes, 'sync'); } catch (e) {}
    });
  }

  function resolve(keys) {
    var all = snapshot();
    if (keys === null || keys === undefined) return all;
    if (typeof keys === 'string') {
      var one = {}; one[keys] = all[keys]; return one;
    }
    if (Array.isArray(keys)) {
      var arr = {};
      keys.forEach(function (k) { if (k in all) arr[k] = all[k]; });
      return arr;
    }
    var defaults = {};
    Object.keys(keys).forEach(function (k) {
      defaults[k] = (k in all) ? all[k] : keys[k];
    });
    return defaults;
  }

  window.chrome = {
    runtime: {
      getURL: function (path) {
        return 'pupsi://local/' + String(path || '').replace(/^\/+/, '');
      }
    },
    storage: {
      sync: {
        get: function (keys, cb) {
          var value = resolve(keys);
          if (typeof cb === 'function') setTimeout(function () { cb(value); }, 0);
        },
        set: function (obj, cb) {
          var before = snapshot();
          var changes = {};
          Object.keys(obj || {}).forEach(function (k) {
            changes[k] = { oldValue: before[k], newValue: obj[k] };
            try { localStorage.setItem(PREFIX + k, JSON.stringify(obj[k])); } catch (e) {}
          });
          emit(changes);
          if (typeof cb === 'function') setTimeout(cb, 0);
        },
        remove: function (keys, cb) {
          var before = snapshot();
          var list = Array.isArray(keys) ? keys : [keys];
          var changes = {};
          list.forEach(function (k) {
            changes[k] = { oldValue: before[k] };
            try { localStorage.removeItem(PREFIX + k); } catch (e) {}
          });
          emit(changes);
          if (typeof cb === 'function') setTimeout(cb, 0);
        },
        clear: function (cb) {
          var before = snapshot();
          var changes = {};
          Object.keys(before).forEach(function (k) { changes[k] = { oldValue: before[k] }; });
          try {
            for (var i = localStorage.length - 1; i >= 0; i--) {
              var k = localStorage.key(i);
              if (k && k.indexOf(PREFIX) === 0) localStorage.removeItem(k);
            }
          } catch (e) {}
          emit(changes);
          if (typeof cb === 'function') setTimeout(cb, 0);
        }
      },
      onChanged: {
        addListener: function (fn) { if (listeners.indexOf(fn) === -1) listeners.push(fn); },
        removeListener: function (fn) {
          var i = listeners.indexOf(fn);
          if (i !== -1) listeners.splice(i, 1);
        }
      }
    }
  };
})();
