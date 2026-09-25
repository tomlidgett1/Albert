import assert from "node:assert/strict";
import test from "node:test";
import { selectRuntimeLoginTargets } from "../../scripts/provision-runtime-logins.js";

test("Omni provisioning can select only its own login without reconciling existing services", () => {
  const selected = selectRuntimeLoginTargets([
    "--target=control-plane",
    "--login=albert_omni_control_runtime",
  ]);
  assert.equal(selected.length, 1);
  assert.equal(selected[0]!.adminUrlEnvironmentName, "CONTROL_PLANE_ADMIN_DATABASE_URL");
  assert.deepEqual(selected[0]!.logins.map(({ login, group, passwordEnvironmentName }) => ({
    login, group, passwordEnvironmentName,
  })), [{
    login: "albert_omni_control_runtime",
    group: "albert_omni_control",
    passwordEnvironmentName: "ALBERT_OMNI_CONTROL_DB_PASSWORD",
  }]);
});

test("runtime login selection rejects ambiguous targets and cross-database or unknown logins", () => {
  for (const arguments_ of [
    ["--login=albert_omni_control_runtime"],
    ["--target=analytical", "--login=albert_omni_control_runtime"],
    ["--target=control-plane", "--login=postgres"],
    ["--target=control-plane", "--login="],
    ["--target=control-plane", "--target=analytical"],
    ["--target=control-plane", "--login=albert_omni_control_runtime", "--login=albert_sync_control_runtime"],
    ["--target=control-plane", "--all"],
  ]) assert.throws(() => selectRuntimeLoginTargets(arguments_));
});

test("existing full and per-database login provisioning remains available", () => {
  const all = selectRuntimeLoginTargets([]);
  assert.deepEqual(all.map(({ label }) => label), ["control-plane", "analytical"]);
  for (const cell of all) {
    assert.deepEqual(selectRuntimeLoginTargets([`--target=${cell.label}`]), [cell]);
    assert.ok(cell.logins.length > 1);
  }
});
