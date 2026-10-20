# DeepSeek Search resource and presentation budgets

Candidate relative to `651470f2dfe8bd03d3d52e8d64b0b980290d713a`; not a claim of
independent acceptance or integration. Only explicit DeepSeek Search changes.
Other providers, Fetch, Pi 1.3.0, global hooks, dependencies and search parameters
are unchanged. No model call, retry, provider fallback or new summarizer is added.

## Three separate limits

- **1 MiB (1,048,576 bytes) before JSON parsing:** count bytes from the fetch body
  after transport decoding. A valid decimal Content-Length above this limit is a
  conservative early rejection; missing, low or malformed lengths never disable
  stream accounting. Compressed Content-Length may describe compressed bytes;
  the decoded body must independently fit. On overflow the crossing chunk is not
  retained, and the reader is cancelled and released. A transport can already
  have allocated that chunk; this is not a total-process memory cap. Cancellation
  is not awaited, and external cancellation/30-second timeout retain precedence.
- **32 KiB (32,768 bytes) of complete visible UTF-8 text:** include the localized
  heading, numbering, titles, complete URLs, separators and any excerpt markers.
  This matches the current default L1 text-block ceiling, preventing the current
  server hook from cutting out middle sources on a successful Search result.
  It is local to DeepSeek and is not imported from or applied to other tools.
- **512 KiB (524,288 bytes) of the final UTF-8 JSON `{content, details}`:** include
  the chosen visible text, unchanged mapped results, metadata and JSON escaping.
  Shorter visible text does not excuse oversized details. A JSONL message wrapper
  and other session entries add bytes beyond this tool-result budget.

The previous design review of the [Search guide](https://api-docs.deepseek.com/guides/search/)
records 1–50 results, summaries typically 600–800 characters and snippets typically
100–200. Those lengths are not maxima. This candidate retains the earlier 1 MiB /
512 KiB policy: fifty 800+200 supplementary characters alone need about 200 KB in
UTF-8, or 600 KB if every character uses JSON surrogate escapes. The read budget
leaves room for titles, URLs and metadata. The saved-result budget leaves room
for the full mapped metadata as well as up to 32 KiB of visible text. Neither
limit promises to accept every schema-valid response or measures production use.
The response still requests `need_content: false`; an unexpected nonempty content
field must pass the read limit even though it is not retained.

## Presentation contract

1. Construct the existing summary-first text (`summary || snippet`). If its full
   UTF-8 size fits, return it unchanged. Source text is inserted literally so
   `$&`, `$``, `$'` and `$$` in URLs or excerpts are not replacement patterns.
2. Only when that text exceeds 32 KiB, consider existing nonblank snippets whose
   complete marked text is smaller than the original content in UTF-8. The marker
   is `[Shorter excerpt from search provider] ` (39 bytes). Do not trim or generate
   the snippet, and do not treat equal/longer/blank snippets as improvements.
3. Replace sources in descending byte savings, ties by original source order,
   stopping as soon as the full text fits. This minimizes the number of replaced
   summaries for this additive byte budget; it is not a claim of semantic quality
   optimization. Numbering and output order never change. Each replaced source
   carries the marker; all others keep their complete original content.
4. If all useful replacements still do not fit, return a fixed
   `details.error_type = "response_too_large"` with advice to narrow the query or
   reduce count. Do not slice text/URLs, drop sources, return partial success or
   retry. The same error type is used for read and saved-result limits, with
   distinct fixed explanations; rejected source text is not returned in details.

Details keep exactly the pre-existing mapped title, URL, content, rank, score,
provider/source type and nullable metadata (including the original snippet).
They do not gain a presentation field, extra source body or new schema. The
incoming results array is still fully schema-validated before count is applied.
A shorter snippet may omit facts from the original summary; the marker makes
that representational loss explicit without claiming to preserve all facts.

## Measured acceptance and rejection examples

All rows below are synthetic, using the real candidate tool and no network.
The count-50 fixtures use an 800-character summary, 8-character title plus index,
ASCII URL suffix of 32 characters, site name of 30 characters and icon URL suffix
of 128. Character means repeated Unicode code point in these particular rows.
The response column includes escaped Unicode (surrogate pairs for emoji).

| Count / text / snippet length | Response bytes | Original text | Final text | Full result JSON | Shorter excerpts |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 / English / 100 | 1,309 | 909 | 909 | 2,362 | 0 |
| 10 / CJK / 100 | 59,873 | 24,999 | 24,999 | 56,931 | 0 |
| 50 / English / 100 | 64,893 | 44,199 | 32,301 | 97,673 | 18 |
| 50 / CJK / 100 | 299,393 | 124,999 | 32,254 | 191,426 | 45 |
| 50 / emoji / 100 | 580,793 | 165,399 | 30,110 | 236,182 | 49 |

All successful examples retain every title, URL and ordering through the default
real L1 hook. **Maximum count is not guaranteed to fit.** At 200 characters per
snippet, even these moderate fields require 36,949 B (CJK) / 47,349 B (emoji) after
every available replacement. They now fail explicitly instead of returning a
batch whose middle sources are later removed by L1. Earlier fixtures with
100-character titles and 256-character URL suffixes need 61,949 / 76,949 B and
also fail. An emoji fixture with 1,280-character URL suffixes needs 128,149 B.
These are valid-input rejection examples, not evidence that the service returns
such responses frequently; the production rejection rate is unknown. Reducing
count may help, but cannot cure one oversized title, URL, summary or snippet.

A 300 KiB single summary with a short existing snippet fits after marked
presentation (308,101 B full result). Full details remain present and bounded.
A synthetic compact result exactly at 524,288 B passes and remains intact in Pi;
one extra retained byte fails. The observed JSONL for that passing result is
525,192 B including synthetic assistant/tool/session wrappers. This is not a
claim that every session wrapper has the same size.

## Consumers, compatibility and rollback

The tool emits its existing `{content, details}` success/error shape, without
structuredContent. Search key verification uses the bounded backend and still
returns a boolean; it does not run presentation. The provider-normalization and
credential/queue contracts are unchanged. UI search labels use the query; generic
tool event/session consumers retain content/details. This candidate does not
change their outcome classification or add `isError` to Search's old error shape.

Pi 1.3.0 ExtensionRunner and AgentSession preserve details when L1 leaves text
unchanged. SessionManager writes them in JSONL v3; convertToLlm retains them, and
the OpenAI Chat Completions converter projects content only. Permanent regression
cases use the real L1 handler, SessionManager in a fresh temporary directory and
OpenAI converter. Separate bounded probes exercise the real
ExtensionRunner.emitToolResult → AgentSession._afterToolCall chain as well. No
real user session, model request or GUI is needed for those checks.

No new persistent path, writer, required field, owner, migration, format version
or DATA_EPOCH is introduced. The session-jsonl owner/protocol modules, external Pi
version and registered contracts stay the same. Review the unchanged inventory,
startup receipt and schema fingerprint via their tests; do not reseal them merely
for this payload policy. Old and new readers use the same content/details shapes.
Historical records remain readable and are not rewritten or shrunk. Custom L1
limits below 32 KiB or other modifying extensions can still alter text; this
candidate only proves behavior under the current default hook.

Reverting the candidate restores the previous unbounded read/result behavior and
unmarked presentation subject to L1 clipping. It requires no data migration but
cannot recover rejected responses. A retry would be a new request. Real network
framing/decompression, production response distributions, other model converters,
GUI behavior and downgrade on a real user data directory are not certified here.

## CLI runtime closure review

Regenerate with `node scripts/compute-cli-closure.mjs` after changing imports.
The Search reader reuses `withFetchAbort` from `web-fetch-url.ts` so a pending
read that ignores the request signal still settles on cancellation or timeout;
the helper also observes late rejection and removes its abort listener. Retain
that shared implementation instead of duplicating it merely to avoid census drift.
The generated closure remains 7,137 files (742 source, 11 assets, 6,384 NFT):
only `web-fetch-url.ts` gains Search importer provenance, and the importer order
and derived reason for `shared/deepseek-tools.ts` change. No runtime file or
third-party dependency is added or removed. All three source paths are already
in `export-manifest.json`; the generated open-boundary baseline is byte-identical
with its one existing edge. Closure generators, classifications, allowlists and
test assertions remain unchanged. Recheck the census, writer idempotence and
open-boundary tests; this receipt repair does not change the three budgets above.
