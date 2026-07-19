export function shouldShowWeekNumbers(viewOptions) {
  return viewOptions?.showWeekNumbers !== false;
}

export function getWeekStartsOn(viewOptions) {
  return viewOptions?.weekStartsOnSunday !== false ? 0 : 1;
}
