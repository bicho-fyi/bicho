# OTLP schemas

The OpenTelemetry `.proto` files come from [opentelemetry-proto v1.11.0](https://github.com/open-telemetry/opentelemetry-proto/tree/v1.11.0). Their original copyright headers and Apache-2.0 license are retained.

`google/rpc/status.proto` comes from [googleapis](https://github.com/googleapis/googleapis/blob/master/google/rpc/status.proto). Its copyright header and Apache-2.0 license are retained. The generated descriptor also includes the Protobuf `google/protobuf/any.proto` definition supplied by protoc; its BSD license is in `LICENSE.protobuf`.

`schema.ts` contains a compiled FileDescriptorSet for the logs service and error status, including imports. The runtime reads it with `@bufbuild/protobuf`; it does not fetch schemas or generate code on requests.

To rebuild the descriptor from these files with protoc:

```sh
protoc -I src/vendor/otlp -I /path/to/protobuf/include \
  --include_imports --descriptor_set_out=_temp/otlp-schema/logs.pb \
  opentelemetry/proto/collector/logs/v1/logs_service.proto google/rpc/status.proto
```

Replace the base64 FileDescriptorSet in `schema.ts` with the resulting descriptor. These files retain their upstream licenses; they are not relicensed under Bicho's Apache-2.0 license.
