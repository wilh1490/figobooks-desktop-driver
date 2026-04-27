/**
 * src/config.js
 * Persists driver settings to ~/.figobooks/driver-config.json
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const CONFIG_DIR  = path.join(os.homedir(), '.figobooks');
const CONFIG_FILE = path.join(CONFIG_DIR, 'driver-config.json');

let _cache = null;

function load() {
  if (_cache) return _cache;
  try {
    if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
    if (!fs.existsSync(CONFIG_FILE)) {
      _cache = {};
      return _cache;
    }
    _cache = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    _cache = {};
  }
  return _cache;
}

function save() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(_cache, null, 2), 'utf8');
  } catch {}
}

function get(key) {
  return load()[key];
}

function set(key, value) {
  load();
  _cache[key] = value;
  save();
}

function remove(key) {
  load();
  delete _cache[key];
  save();
}

function all() {
  return load();
}

module.exports = { get, set, remove, all };
