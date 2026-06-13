export function serviceTaskOutputEntries() {
  return [
    {
      id: 'sim-output-distribution',
      label: 'Output Distribution',
      path: ['output', 'distribution'],
      control: 'select',
      options: [
        { label: 'Categorical', value: 'categorical' },
        { label: 'None', value: 'none' }
      ]
    },
    {
      id: 'sim-possible-outputs',
      label: 'Possible Outputs',
      path: ['output', 'possibleOutputs'],
      control: 'text',
      description: 'Format: value:probability, value:probability'
    },
    {
      id: 'sim-error-probability',
      label: 'Error Probability',
      path: ['error', 'probability'],
      control: 'text',
      type: 'number',
      min: '0',
      max: '1',
      step: '0.01',
      validate: 'probability'
    },
    {
      id: 'sim-possible-errors',
      label: 'Possible Errors',
      path: ['error', 'possibleErrors'],
      control: 'text',
      description: 'Format: errorCode:probability, errorCode:probability'
    }
  ];
}
