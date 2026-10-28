/**
 * PnLChart — Lightweight Canvas line chart for P/L history.
 *
 * Renders a smooth bezier line chart with gradient fill, crosshair,
 * and tooltip. Zero external dependencies.
 *
 * @example
 *   const canvas = document.getElementById('pnl-canvas');
 *   PnLChart.render(canvas, [
 *     { date: '2026-01-15', pnl: 480.20, pct: 2.15 },
 *     { date: '2026-02-15', pnl: 620.00, pct: 2.80 },
 *   ], {
 *     theme: 'dark',
 *     onHover: (point) => console.log(point),
 *     onLeave: () => console.log('left'),
 *   });
 *
 *   // Later:
 *   PnLChart.destroy(canvas);
 */

const PnLChart = {
  /**
   * Active chart instances, keyed by canvas element.
   * Each value: { data, options, observer, rafId, hoveredIndex, mouseX, mouseY, tooltipEl }
   * @type {Map<HTMLCanvasElement, Object>}
   */
  _instances: new Map(),

  // ─── PUBLIC API ─────────────────────────────────────────

  /**
   * Render the P/L chart on a canvas element.
   * If the canvas already has a chart, it is destroyed and re-rendered.
   *
   * @param {HTMLCanvasElement} canvas - Target canvas element
   * @param {Array<{date: string, pnl: number, pct: number}>} data - Time series data
   * @param {Object} [options={}] - Configuration options
   * @param {'light'|'dark'} [options.theme] - Theme override (auto-detected if omitted)
   * @param {HTMLElement} [options.tooltip] - Tooltip element to position (optional, found by class if omitted)
   * @param {(point: Object) => void} [options.onHover] - Called when user hovers a data point
   * @param {() => void} [options.onLeave] - Called when user leaves the chart
   */
  render(canvas, data, options = {}) {
    if (!canvas || !(canvas instanceof HTMLCanvasElement)) {
      console.warn('PnLChart.render: first argument must be a <canvas> element');
      return;
    }

    // Destroy any existing instance on this canvas
    if (this._instances.has(canvas)) {
      this.destroy(canvas);
    }

    if (!data || data.length === 0) return;

    // Resolve theme
    const theme = options.theme || this._detectTheme();

    // Resolve tooltip element
    let tooltipEl = options.tooltip || null;
    if (!tooltipEl) {
      const container = canvas.closest('.pnl-chart-container');
      if (container) {
        tooltipEl = container.querySelector('.pnl-tooltip');
      }
    }

    // Set up high-DPI canvas
    this._setupCanvas(canvas);

    const instance = {
      data: data,
      options: { ...options, theme, tooltipEl },
      observer: null,
      rafId: null,
      hoveredIndex: -1,
      mouseX: -1,
      mouseY: -1,
      bounds: null,
    };

    this._instances.set(canvas, instance);

    // Bind interaction handlers
    this._bindEvents(canvas, instance);

    // ResizeObserver for responsive redraw
    if (typeof ResizeObserver !== 'undefined') {
      instance.observer = new ResizeObserver(() => {
        this._setupCanvas(canvas);
        this._scheduleRedraw(canvas);
      });
      instance.observer.observe(canvas);
    } else {
      // Fallback: window resize
      instance._resizeHandler = () => {
        this._setupCanvas(canvas);
        this._scheduleRedraw(canvas);
      };
      window.addEventListener('resize', instance._resizeHandler);
    }

    // Initial draw — delay one frame to ensure layout is computed
    // (canvas may have 0 dimensions if called right after display change)
    requestAnimationFrame(() => {
      const rect = canvas.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        this._setupCanvas(canvas);
        this._scheduleRedraw(canvas);
      } else {
        // Retry after a short delay if canvas still has no dimensions
        setTimeout(() => {
          this._setupCanvas(canvas);
          this._scheduleRedraw(canvas);
        }, 50);
      }
    });
  },

  /**
   * Destroy a chart instance and clean up all resources.
   *
   * @param {HTMLCanvasElement} canvas - The canvas to clean up
   */
  destroy(canvas) {
    const instance = this._instances.get(canvas);
    if (!instance) return;

    // Cancel pending animation frame
    if (instance.rafId) {
      cancelAnimationFrame(instance.rafId);
    }

    // Disconnect ResizeObserver
    if (instance.observer) {
      instance.observer.disconnect();
    }

    // Remove resize fallback listener
    if (instance._resizeHandler) {
      window.removeEventListener('resize', instance._resizeHandler);
    }

    // Unbind event handlers
    this._unbindEvents(canvas, instance);

    // Clear canvas
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }

    // Hide tooltip if visible
    this._hideTooltip(instance);

    this._instances.delete(canvas);
  },

  // ─── CANVAS SETUP ──────────────────────────────────────

  /**
   * Set up canvas dimensions for high-DPI displays.
   * @param {HTMLCanvasElement} canvas
   * @private
   */
  _setupCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    const w = Math.round(rect.width * dpr);
    const h = Math.round(rect.height * dpr);

    // Skip if dimensions haven't changed (prevents ResizeObserver loop)
    if (canvas.width === w && canvas.height === h) return;

    canvas.width = w;
    canvas.height = h;

    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.scale(dpr, dpr);
    }
  },

  // ─── THEME ──────────────────────────────────────────────

  /**
   * Detect the current theme from the document.
   * @returns {'light'|'dark'}
   * @private
   */
  _detectTheme() {
    if (document.documentElement.dataset.theme === 'light') return 'light';
    if (document.documentElement.dataset.theme === 'dark') return 'dark';
    // Fallback: check system preference
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
      return 'light';
    }
    return 'dark';
  },

  /**
   * Get color palette for a theme.
   * @param {'light'|'dark'} theme
   * @returns {Object}
   * @private
   */
  _getThemeColors(theme) {
    if (theme === 'light') {
      return {
        grid: 'rgba(0, 0, 0, 0.20)',
        crosshair: 'rgba(0, 0, 0, 0.3)',
        axisText: 'rgba(0, 0, 0, 0.45)',
        pointFill: '#FFFFFF',
        positive: '#34C759',
        negative: '#FF3B30',
        bg: '#FFFFFF',
      };
    }
    return {
      grid: 'rgba(255, 255, 255, 0.20)',
      crosshair: 'rgba(255, 255, 255, 0.3)',
      axisText: 'rgba(255, 255, 255, 0.3)',
      pointFill: '#000000',
      positive: '#34C759',
      negative: '#FF3B30',
      bg: '#000000',
    };
  },

  // ─── DRAWING ────────────────────────────────────────────

  /**
   * Full chart redraw. Debounced via requestAnimationFrame.
   * @param {HTMLCanvasElement} canvas
   * @private
   */
  _scheduleRedraw(canvas) {
    const instance = this._instances.get(canvas);
    if (!instance) return;

    if (instance.rafId) {
      cancelAnimationFrame(instance.rafId);
    }

    instance.rafId = requestAnimationFrame(() => {
      instance.rafId = null;
      this._draw(canvas);
    });
  },

  /**
   * Main draw routine — clears canvas and renders all layers.
   * @param {HTMLCanvasElement} canvas
   * @private
   */
  _draw(canvas) {
    const instance = this._instances.get(canvas);
    if (!instance) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { data, options } = instance;
    const colors = this._getThemeColors(options.theme);
    const rect = canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;

    // Clear
    ctx.clearRect(0, 0, w, h);

    // Layout bounds — padding for axis labels
    const paddingLeft = 42;
    const paddingRight = 10;
    const paddingTop = 8;
    const paddingBottom = 22;

    const bounds = {
      left: paddingLeft,
      right: w - paddingRight,
      top: paddingTop,
      bottom: h - paddingBottom,
      width: w - paddingLeft - paddingRight,
      height: h - paddingTop - paddingBottom,
    };
    instance.bounds = bounds;

    // Compute Y-axis range from percentage values
    const pcts = data.map((d) => d.pct);
    let yMin = Math.min(...pcts);
    let yMax = Math.max(...pcts);

    // Add padding (at least 1% range)
    const range = yMax - yMin;
    if (range < 1) {
      const mid = (yMax + yMin) / 2;
      yMin = mid - 0.5;
      yMax = mid + 0.5;
    } else {
      const padding = range * 0.12;
      yMin -= padding;
      yMax += padding;
    }

    // Generate nice Y-axis ticks
    const yTicks = this._generateNiceTicks(yMin, yMax, 5);
    yMin = yTicks[0];
    yMax = yTicks[yTicks.length - 1];

    // Compute pixel positions for each data point
    // Use safeLength to avoid division by zero when data has a single point
    const safeLength = Math.max(data.length - 1, 1);
    const points = data.map((d, i) => ({
      x: data.length === 1
        ? bounds.left + bounds.width / 2
        : bounds.left + (i / safeLength) * bounds.width,
      y: bounds.top + bounds.height - ((d.pct - yMin) / (yMax - yMin)) * bounds.height,
      data: d,
      index: i,
    }));

    // Determine line color based on overall P/L
    const lastPct = data[data.length - 1].pct;
    const lineColor = lastPct >= 0 ? colors.positive : colors.negative;

    // Draw layers in order: grid → gradient fill → line → data points → crosshair
    this._drawGrid(ctx, bounds, yTicks, yMin, yMax, colors);
    this._drawYAxisLabels(ctx, bounds, yTicks, colors);
    this._drawXAxisLabels(ctx, bounds, data, colors);
    this._drawGradientFill(ctx, points, bounds, lineColor, yMin, yMax);
    this._drawLine(ctx, points, lineColor);
    this._drawDataPoints(ctx, points, lineColor, colors, instance.hoveredIndex);

    if (instance.hoveredIndex >= 0) {
      this._drawCrosshair(ctx, points[instance.hoveredIndex], bounds, colors);
    }
  },

  /**
   * Draw horizontal grid lines.
   * @param {CanvasRenderingContext2D} ctx
   * @param {Object} bounds
   * @param {number[]} yTicks
   * @param {number} yMin
   * @param {number} yMax
   * @param {Object} colors
   * @private
   */
  _drawGrid(ctx, bounds, yTicks, yMin, yMax, colors) {
    ctx.strokeStyle = colors.grid;
    ctx.lineWidth = 1;

    for (let i = 0; i < yTicks.length; i++) {
      const y = bounds.top + bounds.height - ((yTicks[i] - yMin) / (yMax - yMin)) * bounds.height;
      ctx.beginPath();
      ctx.moveTo(bounds.left, Math.round(y) + 0.5);
      ctx.lineTo(bounds.right, Math.round(y) + 0.5);
      ctx.stroke();
    }
  },

  /**
   * Draw Y-axis percentage labels.
   * @param {CanvasRenderingContext2D} ctx
   * @param {Object} bounds
   * @param {number[]} yTicks
   * @param {Object} colors
   * @private
   */
  _drawYAxisLabels(ctx, bounds, yTicks, colors) {
    ctx.fillStyle = colors.axisText;
    ctx.font = `9px ${getComputedStyle(document.documentElement).getPropertyValue('--font').trim()}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';

    const yMin = yTicks[0];
    const yMax = yTicks[yTicks.length - 1];

    for (let i = 0; i < yTicks.length; i++) {
      const y = bounds.top + bounds.height - ((yTicks[i] - yMin) / (yMax - yMin)) * bounds.height;
      ctx.fillText(this._formatPct(yTicks[i]), bounds.left - 6, y);
    }
  },

  /**
   * Draw X-axis month labels at month boundaries.
   * @param {CanvasRenderingContext2D} ctx
   * @param {Object} bounds
   * @param {Array} data
   * @param {Object} colors
   * @private
   */
  _drawXAxisLabels(ctx, bounds, data, colors) {
    ctx.fillStyle = colors.axisText;
    ctx.font = `9px ${getComputedStyle(document.documentElement).getPropertyValue('--font').trim()}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                        'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    // Track which months we've already labeled
    const labeledMonths = new Set();
    const monthPositions = [];

    // Use safeLength to avoid division by zero when data has a single point
    const safeLength = Math.max(data.length - 1, 1);

    data.forEach((d, i) => {
      const date = new Date(d.date + 'T00:00:00');
      const monthKey = date.getFullYear() + '-' + date.getMonth();
      const x = data.length === 1
        ? bounds.left + bounds.width / 2
        : bounds.left + (i / safeLength) * bounds.width;

      if (!labeledMonths.has(monthKey)) {
        labeledMonths.add(monthKey);
        monthPositions.push({ x, label: monthNames[date.getMonth()] });
      }
    });

    // If we'd show too many labels, thin them out
    const maxLabels = Math.floor(bounds.width / 40);
    let displayed = monthPositions;
    if (monthPositions.length > maxLabels) {
      const step = Math.ceil(monthPositions.length / maxLabels);
      displayed = monthPositions.filter((_, i) => i % step === 0);
    }

    displayed.forEach(({ x, label }) => {
      ctx.fillText(label, x, bounds.bottom + 6);
    });
  },

  /**
   * Draw the gradient fill under the line.
   * @param {CanvasRenderingContext2D} ctx
   * @param {Array} points
   * @param {Object} bounds
   * @param {string} lineColor
   * @param {number} yMin
   * @param {number} yMax
   * @private
   */
  _drawGradientFill(ctx, points, bounds, lineColor, yMin, yMax) {
    if (points.length < 2) return;

    // Parse the line color to create gradient
    const isPositive = lineColor === this._getThemeColors('dark').positive;
    const gradient = ctx.createLinearGradient(0, bounds.top, 0, bounds.bottom);

    if (isPositive) {
      gradient.addColorStop(0, 'rgba(52, 199, 89, 0.25)');
      gradient.addColorStop(1, 'rgba(52, 199, 89, 0.02)');
    } else {
      gradient.addColorStop(0, 'rgba(255, 59, 48, 0.25)');
      gradient.addColorStop(1, 'rgba(255, 59, 48, 0.02)');
    }

    // Build smooth path using cubic bezier
    const path = this._buildSmoothPath(points);

    // Close the path at the bottom
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    // Re-trace the curve
    this._traceSmoothCurve(ctx, points);
    ctx.lineTo(points[points.length - 1].x, bounds.bottom);
    ctx.lineTo(points[0].x, bounds.bottom);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();
    ctx.restore();
  },

  /**
   * Draw the smooth line through data points using cubic bezier.
   * @param {CanvasRenderingContext2D} ctx
   * @param {Array} points
   * @param {string} lineColor
   * @private
   */
  _drawLine(ctx, points, lineColor) {
    if (points.length < 2) return;

    ctx.save();
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    this._traceSmoothCurve(ctx, points);
    ctx.stroke();
    ctx.restore();
  },

  /**
   * Trace a smooth cubic bezier curve through points.
   * Uses the midpoint algorithm for natural-looking curves.
   * @param {CanvasRenderingContext2D} ctx
   * @param {Array} points
   * @private
   */
  _traceSmoothCurve(ctx, points) {
    if (points.length < 2) return;

    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[i === 0 ? i : i - 1];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = points[i + 2 < points.length ? i + 2 : i + 1];

      // Catmull-Rom to cubic bezier conversion
      const tension = 0.3;

      const cp1x = p1.x + (p2.x - p0.x) * tension;
      const cp1y = p1.y + (p2.y - p0.y) * tension;
      const cp2x = p2.x - (p3.x - p1.x) * tension;
      const cp2y = p2.y - (p3.y - p1.y) * tension;

      ctx.bezierCurveTo(cp1x, cp1y, cp2x, cp2y, p2.x, p2.y);
    }
  },

  /**
   * Build a smooth path object (for potential reuse).
   * @param {Array} points
   * @returns {string} SVG-style path d attribute (not used for Canvas, kept for reference)
   * @private
   */
  _buildSmoothPath(points) {
    // This method exists for structural clarity; actual drawing uses _traceSmoothCurve
    return '';
  },

  /**
   * Draw data point circles.
   * Hollow circles for all points, filled circle for the hovered point.
   * @param {CanvasRenderingContext2D} ctx
   * @param {Array} points
   * @param {string} lineColor
   * @param {Object} colors
   * @param {number} hoveredIndex
   * @private
   */
  _drawDataPoints(ctx, points, lineColor, colors, hoveredIndex) {
    points.forEach((pt, i) => {
      ctx.save();

      if (i === hoveredIndex) {
        // Filled, larger circle for hovered point
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 4, 0, Math.PI * 2);
        ctx.fillStyle = lineColor;
        ctx.fill();
        ctx.strokeStyle = colors.bg;
        ctx.lineWidth = 2;
        ctx.stroke();
      } else {
        // Small hollow circle
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, 2.5, 0, Math.PI * 2);
        ctx.fillStyle = colors.bg;
        ctx.fill();
        ctx.strokeStyle = lineColor;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }

      ctx.restore();
    });
  },

  /**
   * Draw crosshair lines at the hovered data point.
   * Vertical dashed line from top to bottom of chart area.
   * Horizontal dashed line from left axis to the data point.
   * @param {CanvasRenderingContext2D} ctx
   * @param {Object} point - {x, y} pixel position of the data point
   * @param {Object} bounds
   * @param {Object} colors
   * @private
   */
  _drawCrosshair(ctx, point, bounds, colors) {
    ctx.save();
    ctx.strokeStyle = colors.crosshair;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);

    // Vertical line
    ctx.beginPath();
    ctx.moveTo(Math.round(point.x) + 0.5, bounds.top);
    ctx.lineTo(Math.round(point.x) + 0.5, bounds.bottom);
    ctx.stroke();

    // Horizontal line from Y-axis to data point
    ctx.beginPath();
    ctx.moveTo(bounds.left, Math.round(point.y) + 0.5);
    ctx.lineTo(point.x, Math.round(point.y) + 0.5);
    ctx.stroke();

    ctx.setLineDash([]);
    ctx.restore();
  },

  // ─── AXIS TICK GENERATION ──────────────────────────────

  /**
   * Generate nice round tick values for the Y-axis.
   * @param {number} min - Minimum value
   * @param {number} max - Maximum value
   * @param {number} targetCount - Approximate number of ticks
   * @returns {number[]}
   * @private
   */
  _generateNiceTicks(min, max, targetCount) {
    const range = max - min;
    if (range <= 0) return [min];

    // Find a nice step size
    const rawStep = range / (targetCount - 1);
    const magnitude = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const residual = rawStep / magnitude;

    let niceStep;
    if (residual <= 1.5) niceStep = 1 * magnitude;
    else if (residual <= 3.5) niceStep = 2 * magnitude;
    else if (residual <= 7.5) niceStep = 5 * magnitude;
    else niceStep = 10 * magnitude;

    // Round min down and max up to nice step boundaries
    const niceMin = Math.floor(min / niceStep) * niceStep;
    const niceMax = Math.ceil(max / niceStep) * niceStep;

    const ticks = [];
    for (let v = niceMin; v <= niceMax + niceStep * 0.01; v += niceStep) {
      ticks.push(parseFloat(v.toPrecision(10)));
    }

    return ticks;
  },

  // ─── FORMATTING ─────────────────────────────────────────

  /**
   * Format a percentage value for axis labels.
   * @param {number} pct
   * @returns {string} e.g. "+5.0%", "-2.5%", "0.0%"
   * @private
   */
  _formatPct(pct) {
    const sign = pct > 0 ? '+' : '';
    return sign + pct.toFixed(1) + '%';
  },

  /**
   * Format a date string for the tooltip.
   * @param {string} dateStr - ISO date string "YYYY-MM-DD"
   * @returns {string} e.g. "13 Aug 26"
   * @private
   */
  _formatDate(dateStr) {
    if (typeof formatChartDateDDMONYY === 'function') return formatChartDateDDMONYY(dateStr);
    const date = new Date(dateStr + 'T00:00:00');
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                        'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return monthNames[date.getMonth()] + ' ' + date.getDate() + ', ' + date.getFullYear();
  },

  // ─── INTERACTION ────────────────────────────────────────

  /**
   * Bind mouse/touch event handlers to the canvas.
   * @param {HTMLCanvasElement} canvas
   * @param {Object} instance
   * @private
   */
  _bindEvents(canvas, instance) {
    // Mouse events
    instance._onMouseMove = (e) => this._handleMove(canvas, instance, e);
    instance._onMouseLeave = () => this._handleLeave(canvas, instance);

    // Touch events
    instance._onTouchMove = (e) => {
      e.preventDefault();
      const touch = e.touches[0];
      this._handleMove(canvas, instance, touch);
    };
    instance._onTouchEnd = () => this._handleLeave(canvas, instance);

    canvas.addEventListener('mousemove', instance._onMouseMove);
    canvas.addEventListener('mouseleave', instance._onMouseLeave);
    canvas.addEventListener('touchmove', instance._onTouchMove, { passive: false });
    canvas.addEventListener('touchend', instance._onTouchEnd);
  },

  /**
   * Unbind event handlers.
   * @param {HTMLCanvasElement} canvas
   * @param {Object} instance
   * @private
   */
  _unbindEvents(canvas, instance) {
    if (instance._onMouseMove) canvas.removeEventListener('mousemove', instance._onMouseMove);
    if (instance._onMouseLeave) canvas.removeEventListener('mouseleave', instance._onMouseLeave);
    if (instance._onTouchMove) canvas.removeEventListener('touchmove', instance._onTouchMove);
    if (instance._onTouchEnd) canvas.removeEventListener('touchend', instance._onTouchEnd);
  },

  /**
   * Handle mouse/touch move — find nearest point, update crosshair + tooltip.
   * @param {HTMLCanvasElement} canvas
   * @param {Object} instance
   * @param {MouseEvent|Touch} event
   * @private
   */
  _handleMove(canvas, instance, event) {
    const rect = canvas.getBoundingClientRect();
    const mouseX = event.clientX - rect.left;
    const mouseY = event.clientY - rect.top;

    instance.mouseX = mouseX;
    instance.mouseY = mouseY;

    const nearestIndex = this._findNearestPoint(mouseX, instance.data, instance.bounds);

    if (nearestIndex !== instance.hoveredIndex) {
      instance.hoveredIndex = nearestIndex;
      this._scheduleRedraw(canvas);

      // Show/update tooltip
      if (nearestIndex >= 0) {
        const pt = instance.data[nearestIndex];
        this._showTooltip(instance, pt, nearestIndex);
        if (typeof instance.options.onHover === 'function') {
          instance.options.onHover(pt);
        }
      }
    }

    // Always update tooltip position for smooth tracking
    if (nearestIndex >= 0) {
      this._positionTooltip(instance, nearestIndex);
    }
  },

  /**
   * Handle mouse leave — hide crosshair and tooltip.
   * @param {HTMLCanvasElement} canvas
   * @param {Object} instance
   * @private
   */
  _handleLeave(canvas, instance) {
    if (instance.hoveredIndex >= 0) {
      instance.hoveredIndex = -1;
      instance.mouseX = -1;
      instance.mouseY = -1;
      this._scheduleRedraw(canvas);
      this._hideTooltip(instance);
      if (typeof instance.options.onLeave === 'function') {
        instance.options.onLeave();
      }
    }
  },

  /**
   * Find the nearest data point to a given X pixel coordinate.
   * @param {number} mouseX - Mouse X position in canvas coordinates
   * @param {Array} data - Data array
   * @param {Object} bounds - Chart bounds
   * @returns {number} Index of nearest data point, or -1 if out of range
   * @private
   */
  _findNearestPoint(mouseX, data, bounds) {
    if (!bounds || data.length === 0) return -1;

    // Check if mouse is within the chart area (with some tolerance)
    if (mouseX < bounds.left - 5 || mouseX > bounds.right + 5) return -1;

    // Use safeLength to avoid division by zero when data has a single point
    const safeLength = Math.max(data.length - 1, 1);

    let nearestIndex = 0;
    let nearestDist = Infinity;

    for (let i = 0; i < data.length; i++) {
      const ptX = data.length === 1
        ? bounds.left + bounds.width / 2
        : bounds.left + (i / safeLength) * bounds.width;
      const dist = Math.abs(mouseX - ptX);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestIndex = i;
      }
    }

    // Only snap if reasonably close (within half a data-point spacing)
    const spacing = bounds.width / safeLength;
    if (nearestDist > spacing * 0.6) return -1;

    return nearestIndex;
  },

  // ─── TOOLTIP ────────────────────────────────────────────

  /**
   * Show and populate the tooltip with data point info.
   * @param {Object} instance
   * @param {Object} dataPoint - { date, pnl, pct }
   * @param {number} index
   * @private
   */
  _showTooltip(instance, dataPoint, index) {
    const tooltip = instance.options.tooltipEl;
    if (!tooltip) return;

    const dateEl = tooltip.querySelector('.pnl-tooltip-date');
    const valueEl = tooltip.querySelector('.pnl-tooltip-value');

    if (dateEl) {
      dateEl.textContent = this._formatDate(dataPoint.date);
    }

    if (valueEl) {
      const sign = dataPoint.pnl >= 0 ? '+' : '';
      valueEl.textContent = sign + '$' + Math.abs(dataPoint.pnl).toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      });

      // Apply positive/negative class
      valueEl.classList.toggle('negative', dataPoint.pnl < 0);
    }

    tooltip.style.display = '';
    tooltip.setAttribute('aria-label',
      'P/L on ' + this._formatDate(dataPoint.date) + ': ' + this._formatPct(dataPoint.pct));
  },

  /**
   * Position the tooltip near the hovered data point.
   * @param {Object} instance
   * @param {number} index
   * @private
   */
  _positionTooltip(instance, index) {
    const tooltip = instance.options.tooltipEl;
    if (!tooltip) return;

    const canvas = Array.from(this._instances.keys()).find(
      (k) => this._instances.get(k) === instance
    );
    if (!canvas) return;

    const container = canvas.closest('.pnl-chart-container');
    if (!container) return;

    const containerRect = container.getBoundingClientRect();
    const canvasRect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;

    // Compute pixel position of the data point
    const data = instance.data;
    const bounds = instance.bounds;
    if (!bounds) return;

    // Use safeLength to avoid division by zero when data has a single point
    const safeLength = Math.max(data.length - 1, 1);
    const ptX = data.length === 1
      ? bounds.left + bounds.width / 2
      : bounds.left + (index / safeLength) * bounds.width;
    const yMin = Math.min(...data.map((d) => d.pct));
    const yMax = Math.max(...data.map((d) => d.pct));
    const range = yMax - yMin;
    const paddedMin = yMin - range * 0.12;
    const paddedMax = yMax + range * 0.12;
    const ptY = bounds.top + bounds.height -
      ((data[index].pct - paddedMin) / (paddedMax - paddedMin)) * bounds.height;

    // Convert to container-relative coordinates
    const tooltipWidth = tooltip.offsetWidth || 130;
    const tooltipHeight = tooltip.offsetHeight || 48;

    let left = canvasRect.left - containerRect.left + ptX - tooltipWidth / 2;
    let top = canvasRect.top - containerRect.top + ptY - tooltipHeight - 10;

    // Keep tooltip within container bounds
    if (left < 4) left = 4;
    if (left + tooltipWidth > containerRect.width - 4) {
      left = containerRect.width - tooltipWidth - 4;
    }
    if (top < 4) {
      // If tooltip would go above the container, show it below the point
      top = canvasRect.top - containerRect.top + ptY + 14;
    }

    tooltip.style.left = Math.round(left) + 'px';
    tooltip.style.top = Math.round(top) + 'px';
  },

  /**
   * Hide the tooltip.
   * @param {Object} instance
   * @private
   */
  _hideTooltip(instance) {
    const tooltip = instance.options.tooltipEl;
    if (tooltip) {
      tooltip.style.display = 'none';
    }
  },
};
