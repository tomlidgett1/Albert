# Albert Cube Core semantic layer for Fly.io (albert-cube).
#
# Bakes the data model, the capability driver config (cube.js) and the agents/
# knowledge directory into the official Cube image. Model changes ship by
# redeploying this app: fly deploy -c deploy/fly/cube.toml (from the repo root).
# Exact version pin: model compilation and generated SQL must not change on an
# unrelated image rebuild. Upgrade only with the Cube contract/smoke suite.
FROM cubejs/cube:v1.7.16@sha256:7a33cdc4469ccde403fae519441b06bdcd80e60032d1d793739eb860a0ea3bcc

COPY cube-playground/cube.js /cube/conf/cube.js
COPY cube-playground/model /cube/conf/model
COPY cube-playground/agents /cube/conf/agents
COPY cube-playground/scripts/release-smoke.mjs /cube/conf/scripts/release-smoke.mjs
