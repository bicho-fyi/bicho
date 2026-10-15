# Acknowledgements

Bicho accepts exception and error logs using the OpenTelemetry Protocol (OTLP) over HTTP JSON and binary protobuf.

- [OTLP specification](https://opentelemetry.io/docs/specs/otlp/)
- [Exception log conventions](https://opentelemetry.io/docs/specs/semconv/exceptions/exceptions-logs/)

## Vendored schemas

This distribution includes the following third-party definitions in [src/vendor/otlp](./src/vendor/otlp/README.md):

- [OpenTelemetry protocol schemas](https://github.com/open-telemetry/opentelemetry-proto/tree/v1.11.0), copyright the OpenTelemetry Authors, under [Apache-2.0](./src/vendor/otlp/LICENSE).
- [google.rpc.Status](https://github.com/googleapis/googleapis/blob/master/google/rpc/status.proto), copyright Google LLC, under [Apache-2.0](./src/vendor/otlp/LICENSE).
- The Protobuf `google.protobuf.Any` definition included in the compiled descriptor, copyright Google Inc., under its [BSD license](./src/vendor/otlp/LICENSE.protobuf).

Original copyright headers and license texts are retained with the vendored files. These components remain under their upstream licenses.
