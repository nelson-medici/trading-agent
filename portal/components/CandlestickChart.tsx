"use client";
import { useEffect, useRef, forwardRef, useImperativeHandle } from "react";
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

interface Props {
  candles: Candle[];
  emas?: EmaOverlay[];
  markers?: Marker[];
  horizontalLines?: HorizontalLine[];
  trendLines?: TrendLine[];
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
  { candles, emas = [], markers = [], horizontalLines = [], trendLines = [], height = 480 },
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

  return <div ref={containerRef} style={{ height: `${height}px`, width: "100%" }} />;
});

export default CandlestickChartComponent;
