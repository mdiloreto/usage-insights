# Antigravity wire-format vector

`antigravity-generation.hex` is synthetic, not a captured conversation. It was
encoded and round-tripped with Google's Python `protobuf==6.33.0`, independently
of this repository's JavaScript fixture builder.

The model is `gemini-3-flash-a`, response ID `resp-1`; usage fields are
`1=1132, 2=500, 3=340, 5=16000, 9=300, 10=40`. Field 1 is a model enum id, not a
token count. Expected uncached input is 500; output is 340, including 300
reasoning tokens. Unknown fields exercise fixed32, fixed64 and the maximum
uint64 without interpreting them as usage.

The mapping was measured on real `agy` 1.5.18 data and agrees with the
[current tokscale parser](https://github.com/junhoyeo/tokscale/blob/main/crates/tokscale-core/src/sessions/antigravity_cli.rs).

This checks wire decoding and accounting, not compatibility with every Antigravity
version. The reference is not an official schema; no real-session fixture is supplied.
