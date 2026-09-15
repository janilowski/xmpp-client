-- This server configuration is insecure by design
-- DO NOT COPY BLINDLY
-- see https://prosody.im/doc/configure

local lfs = Lua.require "lfs";
local test_dir = Lua.os.getenv("PROSODY_TEST_DIR") or lfs.currentdir();

local modules_dir = Lua.os.getenv("PROSODY_MODULES_DIR") or (lfs.currentdir() .. "/modules");
plugin_paths = { modules_dir }
plugin_server = "https://modules.prosody.im/rocks/"
installer_plugin_path = modules_dir;

modules_enabled = {
  "roster";
  -- "saslauth";
  "tls";
  "dialback";
  "disco";
  "ping";
  "register";
  "posix";
  "bosh";
  "websocket";
  "time";
  "version";
  "smacks";
  "sasl2";
  "sasl2_bind2";
  "sasl2_sm";
  "sasl2_fast";
  "csi_simple";
};

modules_disabled = {
  "s2s";
}

pidfile = test_dir .. "/prosody.pid";

allow_registration = true;

allow_unencrypted_plain_auth = true;
c2s_require_encryption = false;

consider_websocket_secure = true;
consider_bosh_secure = true;
cross_domain_bosh = true;
cross_domain_websocket = true;

authentication = "internal_plain"

interfaces = { "127.0.0.1", "::1" };
c2s_ports = {};
c2s_direct_tls_ports = {};

log = {
  debug = test_dir .. "/prosody.log";
  error = test_dir .. "/prosody.err";
}

ssl = {
  certificate = test_dir .. "/certs/localhost.crt";
  key = test_dir .. "/certs/localhost.key";
}

data_path = test_dir

VirtualHost "localhost"

Component "component.localhost"
  component_secret = "mysecretcomponentpassword"

VirtualHost "anon.localhost"
  authentication = "anonymous"
