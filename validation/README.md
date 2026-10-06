# Public validation artifacts

This directory intentionally publishes a small, reproducible subset of RhuBase's validation inputs. The full development workspace contains machine-specific logs and historical diagnostics that are not part of the public repository.

Published study inputs:

- [`inference-blind/corpus.json`](inference-blind/corpus.json) and [`inference-blind/expectations.json`](inference-blind/expectations.json): the original 20-family blind snapshot study.
- [`inference-followup-v2/corpus.json`](inference-followup-v2/corpus.json) and [`inference-followup-v2/expectations.json`](inference-followup-v2/expectations.json): the 18-family post-reveal follow-up holdout.

Both studies failed their frozen acceptance thresholds and remain **NO GO**. See the [public validation status](../docs/validation.md) for the metrics, interpretation, and current boundary.

Passing repository tests are regression evidence over controlled inputs. They do not replace an independent holdout, establish migration correctness, or authorize RhuBase to edit an application.
