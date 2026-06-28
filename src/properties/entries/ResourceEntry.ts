export function resourceEntries() {
  return [
    {
      id: 'sim-resource-id',
      label: 'Resource',
      path: ['resource', 'resourceId'],
      control: 'resourceSelect'
    },
    {
      id: 'sim-resource-same-instance',
      label: 'Same instance as before',
      path: ['resource', 'sameInstanceAsBefore'],
      control: 'checkbox'
    }
  ];
}
