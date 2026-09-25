const APPROXIMATE_NIVO_CHARACTER_WIDTH = 7.2;

function estimateLabelWidth(label: string): number {
  return Math.ceil(Array.from(label).length * APPROXIMATE_NIVO_CHARACTER_WIDTH);
}

export function computeLineChartLayout({
  yTickLabels,
  seriesLabels,
}: {
  yTickLabels: readonly string[];
  seriesLabels: readonly string[];
}) {
  const longestYTickWidth = yTickLabels.reduce(
    (longest, label) => Math.max(longest, estimateLabelWidth(label)),
    0,
  );
  const longestSeriesWidth = seriesLabels.reduce(
    (longest, label) => Math.max(longest, estimateLabelWidth(label)),
    0,
  );

  const leftMargin = Math.min(184, Math.max(112, longestYTickWidth + 56));
  const yAxisLegendOffset = -(leftMargin - 22);
  const legendItemWidth = Math.min(280, Math.max(120, longestSeriesWidth + 34));
  // Keep the right edge available to the plot. The legend sits in a dedicated
  // lane below the x-axis instead of consuming a large right-hand margin.
  const legendTranslateX = 0;
  const legendTranslateY = 68;
  const rightMargin = 48;
  const bottomMargin = 94;

  return {
    leftMargin,
    yAxisLegendOffset,
    legendTranslateX,
    legendTranslateY,
    legendItemWidth,
    rightMargin,
    bottomMargin,
  } as const;
}
