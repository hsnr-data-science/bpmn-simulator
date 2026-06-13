export function serviceTaskErrorEntries() {
  return [
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
