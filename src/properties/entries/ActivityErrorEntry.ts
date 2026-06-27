export function activityErrorEntries() {
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
      id: 'sim-error-type',
      label: 'Error Type',
      path: ['error', 'possibleErrors'],
      control: 'errorType'
    }
  ];
}

export function boundaryErrorEntry() {
  return {
    id: 'sim-boundary-error-type',
    label: 'Error Type',
    path: ['errorRef'],
    control: 'errorType'
  };
}
