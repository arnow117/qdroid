FROM node@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203 AS node

FROM ubuntu@sha256:0a9887931b0e38af2e3487ed39e29436b0535c4f3f52e57745baaf79d1898956

LABEL io.qdroid.base-image="ubuntu@sha256:0a9887931b0e38af2e3487ed39e29436b0535c4f3f52e57745baaf79d1898956"
LABEL io.qdroid.node-image="node@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203"
LABEL io.qdroid.profile="qdroid.t002.readonly-sim/v1"

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/LICENSE /usr/share/licenses/node/LICENSE
COPY image/readable-control.txt /opt/qdroid/readable-control.txt
COPY image/io-handshake.mjs /opt/qdroid/io-handshake.mjs
COPY image/workload-client.mjs /opt/qdroid/workload-client.mjs
COPY image/probe.mjs /opt/qdroid/probe.mjs
RUN install -d -m 0777 /opt/qdroid/root-write-control

USER 65532:65532
ENTRYPOINT ["/usr/local/bin/node", "/opt/qdroid/workload-client.mjs"]
