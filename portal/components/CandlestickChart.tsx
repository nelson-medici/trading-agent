"use client";
import { useEffect, useRef, useState, forwardRef, useImperativeHandle } from "react";
import {
  createChart,
  ColorType,
  CrosshairMode,
  LineStyle,
  IChartApi,
  ISeriesApi,
  UTCTimestamp,
  Time,
} from "lightweight-charts";

export interface Candle {
  time: number | string;  // ISO or epoch seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

export interface Marker {
  time: number | string;
  position: "aboveBar" | "belowBar" | "inBar";
  color: string;
  shape: "arrowUp" | "arrowDown" | "circle" | "square";
  text?: string;
}

export interface EmaOverlay {
  period: number;
  color: string;
  values: { time: number | string; value: number }[];
}

export interface HorizontalLine {
  price: number;
  color: string;
  title: string;
  lineStyle?: LineStyle;
}

export interface TrendLine {
  points: { time: number | string; value: number }[];
  color: string;
  lineWidth?: number;
  lineStyle?: LineStyle;
  title?: string;
}

export interface PatternZone {
  id?: string;              // unique identifier for selection
  name: string;
  color: string;           // background color
  fromTime: number | string;
  toTime: number | string;
}

interface Props {
  candles: Candle[];
  emas?: EmaOverlay[];
  markers?: Marker[];
  horizontalLines?: HorizontalLine[];
  trendLines?: TrendLine[];
  patternZones?: PatternZone[];
  selectedZoneId?: string | null;        // which zone is selected
  onZoneSelect?: (id: string | null) => void;  // callback when zone clicked
  height?: number;
}

function toTime(t: number | string): UTCTimestamp {
  if (typeof t === "number") return t as UTCTimestamp;
  // ISO string → epoch seconds
  return Math.floor(new Date(t).getTime() / 1000) as UTCTimestamp;
}

export interface ChartHandle {
  /** Returns the indices [from, to] of candles currently visible on screen */
  getVisibleRange: () => { from: number; to: number } | null;
}

const CandlestickChartComponent = forwardRef<ChartHandle, Props>(function CandlestickChartInner(
  { candles, emas = [], markers = [], horizontalLines = [], trendLines = [], patternZones = [], selectedZoneId = null, onZoneSelect, height = 480 },
  ref,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const emaSeriesRef = useRef<Map<number, ISeriesApi<"Line">>>(new Map());
  const trendLineSeriesRef = useRef<ISeriesApi<"Line">[]>([]);
  const volumeSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const priceLinesRef = useRef<any[]>([]);
  const prevCandleCountRef = useRef(0);

  useImperativeHandle(ref, () => ({
    getVisibleRange() {
      if (!chartRef.current || candles.length === 0) return null;
      const lr = chartRef.current.timeScale().getVisibleLogicalRange();
      if (!lr) return null;
      const from = Math.max(0, Math.floor(lr.from));
      const to = Math.min(candles.length - 1, Math.ceil(lr.to));
      return { from, to };
    },
  }), [candles]);

  // Init
  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      layout: {
        background: { type: ColorType.Solid, color: "#09090b" },
        textColor: "#71717a",
        fontFamily: "'JetBrains Mono', ui-monospace, monospace",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "#18181b", style: LineStyle.Dotted },
        horzLines: { color: "#18181b", style: LineStyle.Dotted },
      },
      crosshair: {
        mode: CrosshairMode.Normal,
        vertLine: { color: "#52525b", width: 1, style: LineStyle.Dashed },
        horzLine: { color: "#52525b", width: 1, style: LineStyle.Dashed },
      },
      rightPriceScale: {
        borderColor: "#27272a",
        scaleMargins: { top: 0.1, bottom: 0.25 },
      },
      timeScale: {
        borderColor: "#27272a",
        timeVisible: true,
        secondsVisible: false,
      },
      autoSize: true,
    });

    const candleSeries = chart.addCandlestickSeries({
      upColor: "#2fb882",
      downColor: "#f94a61",
      borderUpColor: "#2fb882",
      borderDownColor: "#f94a61",
      wickUpColor: "#2fb882",
      wickDownColor: "#f94a61",
    });

    const volumeSeries = chart.addHistogramSeries({
      color: "#52525b",
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
    });
    chart.priceScale("volume").applyOptions({
      scaleMargins: { top: 0.8, bottom: 0 },
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;
    volumeSeriesRef.current = volumeSeries;

    return () => {
      chart.remove();
      chartRef.current = null;
      candleSeriesRef.current = null;
      volumeSeriesRef.current = null;
      emaSeriesRef.current.clear();
      priceLinesRef.current = [];
    };
  }, []);

  // Update candles
  useEffect(() => {
    if (!candleSeriesRef.current || !volumeSeriesRef.current || candles.length === 0) return;

    const candleData = candles.map((c) => ({
      time: toTime(c.time),
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
    }));
    candleSeriesRef.current.setData(candleData);

    const volumeData = candles.map((c) => ({
      time: toTime(c.time),
      value: c.volume ?? 0,
      color: c.close >= c.open ? "#2fb88220" : "#f94a6120",
    }));
    volumeSeriesRef.current.setData(volumeData);

    // fitContent only on first load or when dataset significantly changes
    // (symbol/timeframe change = very different count or first candle time)
    // Don't reset zoom on periodic data refresh (same candles, maybe +1 new)
    const countDiff = Math.abs(candles.length - prevCandleCountRef.current);
    if (prevCandleCountRef.current === 0 || countDiff > 10) {
      chartRef.current?.timeScale().fitContent();
    }
    prevCandleCountRef.current = candles.length;
  }, [candles]);

  // Update EMAs
  useEffect(() => {
    if (!chartRef.current) return;

    // Limpiar series previas
    emaSeriesRef.current.forEach((series) => chartRef.current?.removeSeries(series));
    emaSeriesRef.current.clear();

    for (const ema of emas) {
      const series = chartRef.current.addLineSeries({
        color: ema.color,
        lineWidth: 2,
        priceLineVisible: false,
        lastValueVisible: true,
        title: `EMA${ema.period}`,
      });
      series.setData(
        ema.values.map((v) => ({ time: toTime(v.time), value: v.value }))
      );
      emaSeriesRef.current.set(ema.period, series);
    }
  }, [emas]);

  // Update markers
  useEffect(() => {
    if (!candleSeriesRef.current) return;
    const mapped = markers.map((m) => ({
      time: toTime(m.time),
      position: m.position,
      color: m.color,
      shape: m.shape,
      text: m.text,
    }));
    candleSeriesRef.current.setMarkers(mapped);
  }, [markers]);

  // Update trend lines (diagonal lines connecting points)
  useEffect(() => {
    if (!chartRef.current) return;
    // Remove previous
    trendLineSeriesRef.current.forEach((s) => { try { chartRef.current?.removeSeries(s); } catch {} });
    trendLineSeriesRef.current = [];

    for (const tl of trendLines) {
      if (tl.points.length < 2) continue;
      const series = chartRef.current.addLineSeries({
        color: tl.color,
        lineWidth: (tl.lineWidth ?? 1) as 1 | 2 | 3 | 4,
        lineStyle: tl.lineStyle ?? LineStyle.Dashed,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
        title: "", // no title on axis — too much clutter
      });
      series.setData(
        tl.points.map((p) => ({ time: toTime(p.time), value: p.value }))
      );
      trendLineSeriesRef.current.push(series);
    }
  }, [trendLines]);

  // Update horizontal lines
  useEffect(() => {
    if (!candleSeriesRef.current) return;
    priceLinesRef.current.forEach((pl) => candleSeriesRef.current?.removePriceLine(pl));
    priceLinesRef.current = [];
    for (const line of horizontalLines) {
      const pl = candleSeriesRef.current.createPriceLine({
        price: line.price,
        color: line.color,
        lineWidth: 1,
        lineStyle: line.lineStyle ?? LineStyle.Dashed,
        axisLabelVisible: false,
        title: line.title,
      });
      priceLinesRef.current.push(pl);
    }
  }, [horizontalLines]);

  // Pattern zone overlays: stacked labels at the top of the chart
  interface ZonePos { id: string; name: string; color: string; left: number; width: number; row: number; }
  const [zonePositions, setZonePositions] = useState<ZonePos[]>([]);

  useEffect(() => {
    if (!chartRef.current || patternZones.length === 0 || candles.length === 0) {
      setZonePositions([]);
      return;
    }

    const updateZones = () => {
      if (!chartRef.current) return;
      const ts = chartRef.current.timeScale();
      const raw: { id: string; name: string; color: string; left: number; right: number; width: number }[] = [];

      for (let i = 0; i < patternZones.length; i++) {
        const zone = patternZones[i];
        const fromCoord = ts.timeToCoordinate(toTime(zone.fromTime));
        const toCoord = ts.timeToCoordinate(toTime(zone.toTime));
        if (fromCoord === null || toCoord === null) continue;

        const left = Math.min(fromCoord, toCoord);
        const right = Math.max(fromCoord, toCoord);
        const width = right - left;
        if (width < 20) continue;

        raw.push({ id: zone.id ?? `z${i}`, name: zone.name, color: zone.color, left, right, width });
      }

      // Stack: assign rows to avoid overlap
      const ROW_HEIGHT = 18;
      const rows: { left: number; right: number }[][] = [];
      const positioned: ZonePos[] = [];

      for (const z of raw) {
        let assignedRow = -1;
        for (let r = 0; r < rows.length; r++) {
          const overlaps = rows[r].some((s) => !(z.right < s.left || z.left > s.right));
          if (!overlaps) { assignedRow = r; break; }
        }
        if (assignedRow === -1) {
          assignedRow = rows.length;
          rows.push([]);
        }
        rows[assignedRow].push({ left: z.left, right: z.right });
        positioned.push({ ...z, row: assignedRow });
      }

      setZonePositions(positioned);
    };

    updateZones();
    const ts = chartRef.current.timeScale();
    ts.subscribeVisibleLogicalRangeChange(updateZones);
    return () => { ts.unsubscribeVisibleLogicalRangeChange(updateZones); };
  }, [patternZones, candles]);

  const maxRow = zonePositions.length > 0 ? Math.max(...zonePositions.map((z) => z.row)) : -1;
  const zonesHeight = (maxRow + 1) * 18;

  return (
    <div style={{ position: "relative", height: `${height + zonesHeight}px`, width: "100%" }}>
      {/* Stacked zone labels */}
      {zonesHeight > 0 && (
        <div style={{ position: "relative", height: `${zonesHeight}px`, width: "100%" }}>
          {zonePositions.map((z) => {
            const isSelected = selectedZoneId === z.id;
            const isOther = selectedZoneId != null && !isSelected;
            return (
              <div key={z.id} style={{
                position: "absolute",
                top: `${z.row * 18}px`,
                left: `${z.left}px`,
                width: `${z.width}px`,
                height: "16px",
                zIndex: isSelected ? 10 : 5,
                cursor: "pointer",
                opacity: isOther ? 0.3 : 1,
                transition: "opacity 0.2s",
              }}
                onClick={() => onZoneSelect?.(isSelected ? null : z.id)}
              >
                <div style={{
                  background: z.color,
                  height: "100%",
                  padding: "0 6px",
                  fontSize: "9px",
                  fontWeight: 600,
                  letterSpacing: "0.05em",
                  textTransform: "uppercase",
                  color: "#000",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  borderBottom: isSelected ? `2px solid ${z.color}` : "none",
                }}>
                  {z.name}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Chart */}
      <div ref={containerRef} style={{ height: `${height}px`, width: "100%" }} />

      {/* Vertical guide lines for selected zone */}
      {selectedZoneId && zonePositions.filter((z) => z.id === selectedZoneId).map((z) => (
        <div key={`guide-${z.id}`}>
          <div style={{
            position: "absolute", top: `${zonesHeight}px`, left: `${z.left}px`,
            width: "1px", height: `${height}px`, background: `${z.color}50`, zIndex: 4,
          }} />
          <div style={{
            position: "absolute", top: `${zonesHeight}px`, left: `${z.left + z.width}px`,
            width: "1px", height: `${height}px`, background: `${z.color}50`, zIndex: 4,
          }} />
          {/* Dim overlay outside the pattern zone */}
          {z.left > 0 && (
            <div style={{
              position: "absolute", top: `${zonesHeight}px`, left: 0,
              width: `${z.left}px`, height: `${height}px`,
              background: "rgba(0,0,0,0.5)", zIndex: 3, pointerEvents: "none",
            }} />
          )}
          <div style={{
            position: "absolute", top: `${zonesHeight}px`, left: `${z.left + z.width}px`,
            right: 0, height: `${height}px`,
            background: "rgba(0,0,0,0.5)", zIndex: 3, pointerEvents: "none",
          }} />
        </div>
      ))}
    </div>
  );
});

export default CandlestickChartComponent;
