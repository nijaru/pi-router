import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";

test("environment mode overrides the default", () => {
  const config = loadConfig({ env: { PI_ROUTER_MODE: "auto" } });
  assert.equal(config.mode, "auto");
});

test("PI_ROUTER_OFF forces config off", () => {
  const config = loadConfig({ env: { PI_ROUTER_MODE: "auto", PI_ROUTER_OFF: "1" } });
  assert.equal(config.mode, "off");
});
