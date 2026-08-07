export interface AliasPoolPushButtonStateInput {
  configured: boolean;
  activeCount: number;
  selectedCount: number;
  submitting: boolean;
}

export interface AliasPoolPushButtonState {
  selectedDisabled: boolean;
  allDisabled: boolean;
}

export function aliasPoolPushButtonState(
  input: AliasPoolPushButtonStateInput,
): AliasPoolPushButtonState {
  const unavailable = !input.configured || input.submitting;
  return {
    selectedDisabled: unavailable || input.selectedCount === 0,
    allDisabled: unavailable || input.activeCount === 0,
  };
}
