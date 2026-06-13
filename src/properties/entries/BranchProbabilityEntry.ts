export function branchProbabilityEntries() {
  return [
    {
      id: 'sim-branch-probability',
      label: 'Branch Probability',
      path: ['branch', 'probability'],
      control: 'text',
      type: 'number',
      min: '0',
      max: '1',
      step: '0.01',
      validate: 'probability'
    }
  ];
}
