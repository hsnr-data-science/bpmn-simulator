export function resourceEntries() {
  return [
    {
      id: 'sim-resource-id',
      label: 'Resource',
      path: ['resource', 'resourceId'],
      control: 'resourceSelect'
    },
    {
      id: 'sim-failure-probability',
      label: 'Failure Probability',
      path: ['failure', 'probability'],
      control: 'text',
      type: 'number',
      min: '0',
      max: '1',
      step: '0.01',
      validate: 'probability'
    },
    {
      id: 'sim-retry-count',
      label: 'Retry Count',
      path: ['failure', 'retryCount'],
      control: 'text',
      type: 'number',
      min: '0',
      step: '1',
      validate: 'nonNegativeInteger'
    },
    {
      id: 'sim-retry-delay-type',
      label: 'Retry Delay Distribution',
      path: ['failure', 'retryDelay', 'type'],
      control: 'select',
      options: [
        { label: 'Fixed', value: 'fixed' },
        { label: 'Uniform', value: 'uniform' },
        { label: 'Normal', value: 'normal' },
        { label: 'Exponential', value: 'exponential' },
        { label: 'Triangular', value: 'triangular' }
      ]
    },
    {
      id: 'sim-retry-delay-mean',
      label: 'Retry Delay Mean',
      path: ['failure', 'retryDelay', 'mean'],
      control: 'text',
      type: 'number',
      min: '0',
      step: '0.1',
      validate: 'nonNegativeNumber'
    }
  ];
}
