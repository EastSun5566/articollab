# Security policy

## Reporting a vulnerability

Report suspected vulnerabilities through [GitHub private vulnerability reporting](https://github.com/EastSun5566/articollab/security/advisories/new). Do not open a public issue or pull request with vulnerability details.

Include the affected Articollab version, runtime version, steps or a minimal reproduction, and the expected impact. Do not include credentials or private production data.

If you are unsure whether a problem is a vulnerability, report it privately.

## Security boundaries

Articollab provides a collaboration core. Decode unknown transport data before passing it to typed runtime APIs. Writer sessions and insertion namespace checks do not authenticate callers.

Applications must provide authentication, authorization, transport limits, storage and writer coordination. See the [core boundaries](docs/reference.md#boundaries). Report defects in Articollab's documented guarantees privately, including when they affect an application's integration.
