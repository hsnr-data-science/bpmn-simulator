import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseOutputObjectText,
  sampleOutputObject,
  serializeOutputObjectFields
} from '../../src/simulation/OutputObjects';
import { SeededRandom } from '../../src/simulation/RandomDistributions';

test('OutputObjects parses flat field syntax and serializes it again', () => {
  const fields = parseOutputObjectText(
    'priority:int:randomChoice:1:0.2|2:0.8; amount:float:normal:mean=10,stddev=2,min=0; code:string:random:length=6'
  );

  assert.equal(fields?.length, 3);
  assert.equal(fields?.[0].key, 'priority');
  assert.equal(fields?.[0].type, 'int');
  assert.equal(fields?.[0].generator, 'randomChoice');
  assert.deepEqual(fields?.[0].choices, [
    { value: '1', probability: 0.2 },
    { value: '2', probability: 0.8 }
  ]);
  assert.match(serializeOutputObjectFields(fields), /amount:float:normal/);
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
