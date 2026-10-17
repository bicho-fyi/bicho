# Acknowledgements

Bicho accepts exception and error logs using the OpenTelemetry Protocol (OTLP) over HTTP JSON and binary protobuf.

- [OTLP specification](https://opentelemetry.io/docs/specs/otlp/)
- [Exception log conventions](https://opentelemetry.io/docs/specs/semconv/exceptions/exceptions-logs/)

## Sentry compatibility

Bicho accepts Sentry error envelopes and legacy store requests using the [Sentry envelope format](https://develop.sentry.dev/sdk/data-model/envelopes/).

Interoperability tests use [`@sentry/browser` 11.8.0](https://www.npmjs.com/package/@sentry/browser/v/11.8.0) and [`@sentry/node` 11.8.0](https://www.npmjs.com/package/@sentry/node/v/11.8.0) from the [Sentry JavaScript SDK](https://github.com/getsentry/sentry-javascript). Both SDK packages are MIT-licensed, copyright Functional Software, Inc. dba Sentry (2019 for the browser package and 2023 for the Node package). Their license texts are included in the installed packages.

These SDKs are development dependencies used for testing, not runtime dependencies of Bicho's collector. The MIT designation applies to those SDK packages, not to Sentry's server or every component in its ecosystem.

## Vendored schemas

This distribution includes the following third-party definitions in [src/vendor/otlp](./src/vendor/otlp/README.md):

- [OpenTelemetry protocol schemas](https://github.com/open-telemetry/opentelemetry-proto/tree/v1.11.0), copyright the OpenTelemetry Authors, under [Apache-2.0](./src/vendor/otlp/LICENSE).
- [google.rpc.Status](https://github.com/googleapis/googleapis/blob/master/google/rpc/status.proto), copyright Google LLC, under [Apache-2.0](./src/vendor/otlp/LICENSE).
- The Protobuf `google.protobuf.Any` definition included in the compiled descriptor, copyright Google Inc., under its [BSD license](./src/vendor/otlp/LICENSE.protobuf).

Original copyright headers and license texts are retained with the vendored files. These components remain under their upstream licenses.
