# solana-xtomb

The Solana xTOMB program: an Anchor implementation of the Masonry / v4-tomb
design on Solana. Regular SPL tokens (xTOMB / xSHARE / xBOND), Metaplex Core
pass NFTs (Genesis / Pro / Ultra, soulbound), Genesis staking, farms, the
Masonry boardroom, bonds, and a withdrawal Fire Tax.

**Deployed to devnet** — program
`4En9hXzHXTSNvwizNya8oit7MTLfsJxsShnMLgkjttEY`. Test Genesis window
Nov 7 → Nov 14, 2026. Not audited. No pools added yet; no pass or stake has
transacted against the live program yet.

- Spec: `SOLANA-XTOMB-SPEC.md`
- Build report: `MORNING-REPORT.md`
- Deployment record (all addresses): `DEPLOY-REPORT.md`
- Program IDL: `idl/xtomb.json`
- Handoff note for Claude: `HANDOFF-FOR-CLAUDE.md`

Tests: Rust unit 11/11, bankrun 18/18 (`tests/bankrun.ts` needs
`tests/fixtures/mpl-core.so`, which is not in the GitHub copy — see the
handoff note).
