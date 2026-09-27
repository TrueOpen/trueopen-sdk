# Vendored wire vectors

Files here are **byte copies** of vectors published by TrueOpen/wire, vendored only because
the submodule pointer has not caught up yet.

| File | Source | wire commit |
|---|---|---|
| `model_manifest_v4.json` | `testdata/v1/hub/model_manifest_v4.json` | `876dbceededab44f6ff5fe728dd2975942581fb1` (v0.3.0-rc.1) |

## Why a copy exists at all

`third_party/wire` is pinned at v0.2.1, which predates these vectors. Advancing the pointer
to v0.3.0-rc.1 is not a small step -- that release freezes the contract a fresh genesis
starts from, drops `TaskOrderV2` for `TaskOrderV3`, moves the EIP-712 order domain to `"3"`,
turns `model_id` into a Hash32, and rewrites the receipt and evidence vectors. That migration
is its own piece of work. Vendoring one vector lets the manifest layer proceed without it.

## Why this is dangerous, and what guards it

wire's own CHANGELOG makes the argument against copies: two repositories reading one schema
means the second copy is the one that drifts. That risk is real here too.

`test/unit/wire-vector-provenance.test.ts` is the guard. The moment `third_party/wire`
advances to a commit that carries one of these files, the test compares the two byte for byte
and **fails on any difference**. It does not silently prefer either copy.

So the intended lifetime of this directory is short: when the submodule catches up, delete
the copy and point the tests at the submodule path, which is what every other vector-backed
test in this repository already does.
