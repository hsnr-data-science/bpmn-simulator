import test from 'node:test';
import assert from 'node:assert/strict';
import { SeededRandom, pickWeighted, sampleDuration } from '../../src/simulation/RandomDistributions';

test('SeededRandom is deterministic for the same seed', () => {
  const first = new SeededRandom(42);
  const second = new SeededRandom(42);

  assert.deepEqual(
    [first.next(), first.next(), first.next()],
    [second.next(), second.next(), second.next()]
  );
});

test('sampleDuration supports fixed and bounded distributions', () => {
  const random = new SeededRandom(7);

  assert.equal(sampleDuration({ type: 'fixed', mean: 12 }, random), 12);

  const uniform = sampleDuration({ type: 'uniform', min: 2, max: 4 }, random);
  assert.ok(uniform >= 2 && uniform <= 4);

  const triangular = sampleDuration({ type: 'triangular', min: 1, mode: 2, max: 5 }, random);
  assert.ok(triangular >= 1 && triangular <= 5);
});

test('pickWeighted honors deterministic weighted choices', () => {
  const random = new SeededRandom(1);
  const selected = pickWeighted(
    [
      { value: 'a', probability: 0 },
      { value: 'b', probability: 1 }
    ],
    random
  );

  assert.equal(selected?.value, 'b');
});
