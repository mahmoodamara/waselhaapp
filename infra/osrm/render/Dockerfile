# Download, preprocess and serve use immutable image digests.
FROM python:3.13-alpine@sha256:c50ccfb66e5cc97a610dcd0b9597de6ef5b52c96280b51997b353a0fc87a8361 AS download
WORKDIR /download
COPY map-source.json download-map.py ./
# Optional trusted CA bundle for corporate/local build networks. Never persisted
# in an image layer; normal Render builds use the image's standard trust store.
RUN --mount=type=secret,id=build_ca,required=false \
    python download-map.py map-source.json /download/map.osm.pbf

FROM ghcr.io/project-osrm/osrm-backend@sha256:55dbfd47d984c2cacd64e32901b4321c86b5ec761438e69aa053dc78698a786f AS graph
WORKDIR /data
COPY --from=download /download/map.osm.pbf /data/map.osm.pbf
COPY map-source.json /data/map-source.json
# Build only: graph preparation never runs during a Render cold start.
RUN osrm-extract --threads 2 -p /opt/car.lua /data/map.osm.pbf \
    && osrm-partition --threads 2 /data/map.osrm \
    && osrm-customize --threads 2 /data/map.osrm \
    && chmod 0444 /data/map.osrm.* /data/map-source.json

FROM ghcr.io/project-osrm/osrm-backend@sha256:55dbfd47d984c2cacd64e32901b4321c86b5ec761438e69aa053dc78698a786f
LABEL org.opencontainers.image.title="Waselha OSRM routing" \
      org.opencontainers.image.source="https://github.com/mahmoodamara/waselhaapp" \
      org.opencontainers.image.description="OSRM car routing with verified Geofabrik Israel and Palestine data; OpenStreetMap contributors, ODbL 1.0."
WORKDIR /data
COPY --from=graph --chown=65534:65534 /data/map.osrm.* /data/
COPY --from=graph --chown=65534:65534 /data/map-source.json /data/map-source.json
COPY --chown=65534:65534 start-render.sh healthcheck-render.sh ATTRIBUTION.md /opt/waselha/
ENV PORT=10000 OSRM_THREADS=1
USER 65534:65534
EXPOSE 10000
HEALTHCHECK --interval=30s --timeout=5s --start-period=120s --retries=3 \
    CMD ["bash", "/opt/waselha/healthcheck-render.sh"]
ENTRYPOINT ["bash", "/opt/waselha/start-render.sh"]
