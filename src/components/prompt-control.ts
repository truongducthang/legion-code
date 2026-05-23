export function shouldHandoffCoordinatorQuestion(params: {
  controlledBy: 'coordinator' | 'human' | undefined;
  questionActive: boolean;
}): boolean {
  return params.controlledBy === 'coordinator' && params.questionActive;
}
