export function durationDistributionEntries() {
  return [
    {
      id: 'sim-duration-type',
      label: 'Dauerverteilung',
      path: ['duration', 'type'],
      control: 'select',
      options: [
        { label: 'Fixed', value: 'fixed' },
        { label: 'Uniform', value: 'uniform' },
        { label: 'Normal', value: 'normal' },
        { label: 'Exponential', value: 'exponential' },
        { label: 'Triangular', value: 'triangular' }
      ]
    },
    numericEntry('sim-duration-mean', 'Mean / Fixed Value', ['duration', 'mean']),
    numericEntry('sim-duration-stddev', 'Stddev', ['duration', 'stddev']),
    numericEntry('sim-duration-min', 'Minimum', ['duration', 'min']),
    numericEntry('sim-duration-mode', 'Mode', ['duration', 'mode']),
    numericEntry('sim-duration-max', 'Maximum', ['duration', 'max']),
    numericEntry('sim-duration-lambda', 'Lambda', ['duration', 'lambda'])
  ];
}

function numericEntry(id: string, label: string, path: string[]) {
  return {
    id,
    label,
    path,
    control: 'text',
    type: 'number',
    min: '0',
    step: '0.1',
    validate: 'nonNegativeNumber'
  };
}
