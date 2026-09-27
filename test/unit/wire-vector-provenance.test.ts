import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';

/**
 * Guards the vendored copies in `test/fixtures/wire/`.
 *
 * Those files exist because `third_party/wire` is pinned behind the release that published
 * them. wire's own CHANGELOG makes the case against exactly this arrangement: two
 * repositories reading one schema means the second copy is the one that drifts.
 *
 * So the copy is allowed to exist only while the submodule does not carry the file. The
 * moment it does, these tests compare the two byte for byte and fail on any difference --
 * and they deliberately do not prefer either side, because "the submodule is authoritative,
 * so overwrite the copy" would hide a vendored file that had been edited locally.
 *
 * When a comparison starts running and passes, that is the signal to delete the copy and
 * read from the submodule, which is what every other vector-backed test here already does.
 */
const VENDORED = [
  {
    vendored: 'test/fixtures/wire/model_manifest_v4.json',
    submodule: 'third_party/wire/testdata/v1/hub/model_manifest_v4.json',
  },
] as const;

describe('vendored wire vectors', () => {
  for (const { vendored, submodule } of VENDORED) {
    it(`${vendored} is present and parses`, () => {
      expect(existsSync(vendored)).toBe(true);
      expect(() => JSON.parse(readFileSync(vendored, 'utf8'))).not.toThrow();
    });

    it(`${vendored} has not drifted from ${submodule}`, () => {
      if (!existsSync(submodule)) {
        // The submodule predates this vector. Nothing to compare yet; the copy stands in.
        expect(existsSync(vendored)).toBe(true);
        return;
      }
      // Byte comparison, not a parsed-object comparison: canonical encoding is a
      // byte-level contract, and two files that parse alike can still hash differently.
      const a = readFileSync(vendored);
      const b = readFileSync(submodule);
      expect(
        a.equals(b),
        `${vendored} differs from ${submodule}. The submodule has caught up: delete the vendored copy and point the tests at the submodule path.`,
      ).toBe(true);
    });
  }
});
