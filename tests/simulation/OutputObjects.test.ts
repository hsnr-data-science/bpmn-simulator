import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseOutputChoices,
  sampleOutputObject,
  serializeOutputChoices
} from '../../src/simulation/OutputObjects';
import { SeededRandom } from '../../src/simulation/RandomDistributions';

test('OutputObjects parses and serializes flat choice lists', () => {
  const choices = parseOutputChoices('1:0.2|2:0.8');

  assert.deepEqual(choices, [
    { value: '1', probability: 0.2 },
    { value: '2', probability: 0.8 }
  ]);
  assert.equal(serializeOutputChoices(choices), '1:0.2|2:0.8');
});

test('OutputObjects samples typed output values deterministically', () => {
  const output = sampleOutputObject({
    fields: [
      {
        key: 'count',
        type: 'int',
        generator: 'fixed',
        value: '3'
      },
      {
        key: 'status',
        type: 'string',
        generator: 'categorical',
        choices: [
          { value: 'ok', probability: 1 }
        ]
      },
      {
        key: 'amount',
        type: 'float',
        generator: 'uniform',
        min: 1,
        max: 2
      }
    ]
  }, new SeededRandom(4));

  assert.equal(output.count, 3);
  assert.equal(output.status, 'ok');
  assert.equal(typeof output.amount, 'number');
});
