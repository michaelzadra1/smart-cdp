# Instrumentation and blocked pages

Direct CDP is not invisible. Record browser version, headless/headful mode,
profile freshness, viewport, locale, cookies, and request sequence when comparing
successful and failing paths. Use real UA/client hints by default. Do not add
cosmetic webdriver overrides or claim that an isolated execution world hides
DOM effects. HTTP-client success/failure does not establish a Chromium verdict.

`Runtime.evaluate` works without `Runtime.enable`. Enable Runtime only for events
the task actually consumes, then disable it. Enable Page/Network before events
that need them. Avoid broad Fetch interception and unneeded injected bridges.
Treat fingerprint explanations as hypotheses requiring matched A/B evidence.

For a noninteractive rate block, compare a fresh `--once` probe, with the same
mode and request sequence, before attributing it to the remote service. Preserve
evidence of the failing response. A probe's behavior does not by itself prove
production scraper parity. Classify failures and avoid false evidence with
[DIAGNOSIS.md](DIAGNOSIS.md).
