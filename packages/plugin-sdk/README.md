# TSPP Plugin SDK

`@tspp/plugin-sdk` is the narrow public boundary between isolated plugin
packages and the TSPP compiler host.

The first version provides plugin identity, API compatibility, deterministic
activation, logging, and cleanup. It intentionally exposes no parser, checker,
or transformer hooks yet. Those ports will be added only alongside a real
plugin that can test and justify them.

Plugin packages should use `definePlugin` for contextual typing and must not
import compiler internals or other plugin implementations.
