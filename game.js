"use strict";

/* ====================================================================
   Conway's Game of Life

   The board is a flat Uint8Array, one byte per cell, indexed
   row * cols + col. There are a few of these running in parallel:

       cur     is this cell alive right now?      (0 / 1)
       nxt     scratch space for the next generation
       saved   snapshot to return to on "reset"
       counts  how many live neighbours each cell has
       age     how recently the cell was alive, for the fading trail

   Flat arrays rather than grid[row][col] because an array-of-arrays-of-
   arrays is thousands of separate heap objects with a pointer chase on
   every read. One contiguous buffer per field is both faster and lets us
   wipe the neighbour counts with a single counts.fill(0).

   Drawing is split across two stacked canvases. The grid lines never
   change, so they get painted once onto the bottom layer and then left
   alone; only the top layer is cleared and repainted per generation. The
   saving there is small — re-stroking the grid every frame measures about
   0.03ms — but it also means a fading cell fades to reveal a crisp grid
   line underneath, rather than the line being repainted over the top of
   it at full strength every frame.
   ==================================================================== */


/* ---- tunables ---------------------------------------------------- */

const MIN_DIM        = 3;    // never let the board get narrower than this
const MIN_CELL       = 3;    // px; below this a cell is not really visible
const GRID_LINE_MIN  = 7;    // px; hide grid lines when cells get tiny
const ROUND_CELL_MIN = 7;    // px; circles at or above this, pixels below
const CELL_FILL      = 0.84; // cell diameter as a fraction of its square
const AGE_MAX        = 255;  // a just-died cell starts fading from here
const RANDOM_DENSITY = 0.28;

// a 19x19 board is a go board's line count, and a nice size to land on
// before you have touched anything
const DEFAULTS = { cell: 14, speed: 12, trail: 60, rule: "B3/S23", rows: 19, cols: 19 };

// valid data-palette values; "" is the default look defined on :root itself
const PALETTES = ["", "go", "chalk", "paper", "amber"];


/* ---- the page --------------------------------------------------- */

const el = {
	step:    document.querySelector("#step"),
	play:    document.querySelector("#play"),
	reset:   document.querySelector("#reset"),
	clear:   document.querySelector("#clear"),
	random:  document.querySelector("#random"),
	gen:     document.querySelector("#gen"),
	pop:     document.querySelector("#pop"),

	zoom:    document.querySelector("#zoom"),
	speed:   document.querySelector("#speed"),
	trail:   document.querySelector("#trail"),
	rows:    document.querySelector("#rows"),
	cols:    document.querySelector("#cols"),
	fit:     document.querySelector("#fit"),
	wrap:    document.querySelector("#wrap"),
	crossings: document.querySelector("#crossings"),
	rule:    document.querySelector("#rule"),
	pattern: document.querySelector("#pattern"),
	palette: document.querySelector("#palette"),

	zoom_out:  document.querySelector("#zoom_out"),
	speed_out: document.querySelector("#speed_out"),
	trail_out: document.querySelector("#trail_out"),

	stage:   document.querySelector(".stage"),
	board:   document.querySelector(".board"),
	grid:    document.querySelector("#grid_layer"),
	cells:   document.querySelector("#cell_layer"),
};

const grid_ctx = el.grid.getContext("2d");
const cell_ctx = el.cells.getContext("2d");

/* Colours come from the stylesheet, keyed off data-palette on <html>, so
   style.css stays the single place a colour is written down — adding a
   palette is a CSS block plus one <option>, nothing here has to change.
   read_theme() re-reads the current values; call it after switching
   data-palette and the board picks up the new look on the next render. */
let COLORS = { board: "", line: "", cell: "" };
let CELL_RGB = { r: 0, g: 0, b: 0 };

function read_theme() {
	const css = getComputedStyle(document.documentElement);
	COLORS.board = css.getPropertyValue("--board").trim()     || "#202d37";
	COLORS.line  = css.getPropertyValue("--grid-line").trim() || "rgba(150,200,220,0.09)";
	COLORS.cell  = css.getPropertyValue("--cell").trim()      || "#bbffcc";
	CELL_RGB = resolve_rgb(COLORS.cell);
}

/* The pixel-writing path needs the cell colour as three bytes, but the
   stylesheet is free to write it as a hex code, rgb(), a colour name, or
   anything else CSS allows. Rather than parse any of that, paint one pixel
   and read back what the canvas made of it. */
function resolve_rgb(color) {
	const probe = document.createElement("canvas");
	probe.width = probe.height = 1;
	const ctx = probe.getContext("2d");
	ctx.fillStyle = color;
	ctx.fillRect(0, 0, 1, 1);
	const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
	return { r, g, b };
}

read_theme();

const TAU = Math.PI * 2;

// age -> alpha, worked out once instead of dividing per cell per frame
const AGE_ALPHA = new Float32Array(AGE_MAX + 1);
for (let a = 0; a <= AGE_MAX; a++) AGE_ALPHA[a] = a / AGE_MAX;


/* ---- state ------------------------------------------------------ */

let rows = 0, cols = 0, cell_count = 0;
let cur = null, nxt = null, saved = null, counts = null, age = null;

let cell_size = DEFAULTS.cell;   // css px per cell
let css_w = 0, css_h = 0;        // board size in css px
let dpr = 1;                     // device pixels per css px

let fit_window = false;          // derive rows/cols from the window?
let wrap_edges = true;           // torus, or hard walls?
let zoom = DEFAULTS.cell;        // desired cell size when fitting
let fixed_rows = DEFAULTS.rows;  // board size when *not* fitting
let fixed_cols = DEFAULTS.cols;
let steps_per_second = DEFAULTS.speed;
let trail_percent = DEFAULTS.trail;
let trail_decay = DEFAULTS.trail / 100;
let remembered_trail = DEFAULTS.trail;  // so [t] can put the trail back

let rule_text = DEFAULTS.rule;
let birth_mask = 0, survive_mask = 0;   // bit n set == "n neighbours does it"

let palette = "";                // "" is the default look; see PALETTES
let stones_on_lines = false;     // dots on grid crossings, like a go board

let generation = 0;
let population = 0;

let running = false;
let raf_id = null;
let last_step = 0;
let needs_render = true;

let armed_pattern = null;        // pattern waiting to be stamped
let hover = null;                // {row, col} under the pointer, for preview
let seeded = false;              // has the opening soup been dealt yet?


/* ====================================================================
   rules
   ==================================================================== */

/* "B3/S23" -> two 9-bit masks. Letters are required so there is no
   ambiguity about which side is which; order does not matter, so
   "S23/B3" parses the same. Returns null if it does not parse. */
function parse_rule(text) {
	const parts = String(text).split("/");
	if (parts.length !== 2) return null;

	let birth = null, survive = null;
	for (const part of parts) {
		const m = /^\s*([bBsS])\s*([0-8]*)\s*$/.exec(part);
		if (!m) return null;

		let mask = 0;
		for (const digit of m[2]) mask |= 1 << Number(digit);

		if (m[1].toLowerCase() === "b") {
			if (birth !== null) return null;      // two B clauses
			birth = mask;
		} else {
			if (survive !== null) return null;    // two S clauses
			survive = mask;
		}
	}
	if (birth === null || survive === null) return null;
	return { birth, survive };
}

function apply_rule(text) {
	const parsed = parse_rule(text);
	if (!parsed) return false;
	birth_mask   = parsed.birth;
	survive_mask = parsed.survive;
	rule_text    = text;
	return true;
}


/* ====================================================================
   the simulation
   ==================================================================== */

/* Only living cells do any work: each one scatters a +1 into its eight
   neighbours. Most cells are interior, where all eight neighbours are a
   fixed offset away and no bounds checking is needed at all — that fast
   path is worth the extra branch. */
function count_neighbours() {
	counts.fill(0);

	for (let row = 0; row < rows; row++) {
		const base = row * cols;
		const interior_row = row > 0 && row < rows - 1;

		for (let col = 0; col < cols; col++) {
			if (cur[base + col] === 0) continue;

			if (interior_row && col > 0 && col < cols - 1) {
				const i = base + col;
				counts[i - cols - 1]++; counts[i - cols]++; counts[i - cols + 1]++;
				counts[i        - 1]++;                     counts[i        + 1]++;
				counts[i + cols - 1]++; counts[i + cols]++; counts[i + cols + 1]++;
			} else {
				scatter_edge(row, col);
			}
		}
	}
}

/* the slow path, for cells on the boundary: either wrap around to the
   far side (a torus) or drop the neighbours that fall off the edge */
function scatter_edge(row, col) {
	for (let dr = -1; dr <= 1; dr++) {
		let r = row + dr;
		if (r < 0 || r >= rows) {
			if (!wrap_edges) continue;
			r = (r + rows) % rows;
		}
		for (let dc = -1; dc <= 1; dc++) {
			if (dr === 0 && dc === 0) continue;
			let c = col + dc;
			if (c < 0 || c >= cols) {
				if (!wrap_edges) continue;
				c = (c + cols) % cols;
			}
			counts[r * cols + c]++;
		}
	}
}

function step() {
	count_neighbours();

	let live = 0;
	for (let i = 0; i < cell_count; i++) {
		const n = counts[i];
		const alive = cur[i] ? (survive_mask >> n) & 1 : (birth_mask >> n) & 1;
		nxt[i] = alive;
		live += alive;
	}

	// swap the buffers rather than copying one into the other
	const spare = cur;
	cur = nxt;
	nxt = spare;

	generation++;
	population = live;
	decay_ages();
	show_counters();
}

/* Each cell carries an "age": being alive pins it at full brightness, and
   once it dies the age decays, which is what draws the fading trail.

   The older way to get this effect was a translucent fill over the whole
   canvas once a frame. That is actually the *cheaper* of the two — it
   measures around 0.01ms, and this loop plus the extra ghosts it puts on
   screen cost rather more than that. It is done this way regardless
   because repeatedly compositing a translucent fill never quite reaches
   zero: 8-bit alpha bottoms out at 1 and stays there, so every cell that
   was ever alive keeps a permanent faint smudge, and a long-running board
   slowly hazes over. Counting down an integer per cell lands on exactly 0
   and stays there. */
function decay_ages() {
	if (trail_decay <= 0) {
		for (let i = 0; i < cell_count; i++) age[i] = cur[i] ? AGE_MAX : 0;
		return;
	}
	for (let i = 0; i < cell_count; i++) {
		if (cur[i]) { age[i] = AGE_MAX; continue; }
		const a = age[i];
		if (a === 0) continue;
		const faded = (a * trail_decay) | 0;
		// always drop at least one, or low ages would round to themselves
		age[i] = faded < a ? faded : a - 1;
	}
}

function count_population() {
	let live = 0;
	for (let i = 0; i < cell_count; i++) live += cur[i];
	population = live;
}


/* ====================================================================
   drawing
   ==================================================================== */

/* Snap a css-pixel coordinate to a device-pixel boundary and then nudge
   it half a device pixel, so a hairline stroke lands inside exactly one
   physical pixel instead of straddling two and going grey. */
function crisp(v) {
	return (Math.round(v * dpr) + 0.5) / dpr;
}

/* Drawn once per resize, never per frame. One path with one stroke() at
   the end, rather than a stroke() per line. */
function draw_grid_layer() {
	grid_ctx.fillStyle = COLORS.board;
	grid_ctx.fillRect(0, 0, css_w, css_h);

	if (cell_size < GRID_LINE_MIN) return;  // lines would just be mush

	grid_ctx.strokeStyle = COLORS.line;
	grid_ctx.lineWidth = 1 / dpr;           // one physical pixel, any display
	grid_ctx.beginPath();

	/* Normally the lines mark cell *boundaries*: rows+1 of them, running
	   flush to every edge. On crossings the dots stay put — dead centre
	   of their cell, same as always — and the lines move instead, to run
	   through those centres rather than around them. That means exactly
	   `rows` lines rather than rows+1, each inset half a cell from the
	   edge, so every dot's crossing sits fully on screen with a matching
	   half-cell margin on all four sides, rather than the dots sitting
	   on the lines and the outermost ones clipping off the board. */
	const line_rows = stones_on_lines ? rows : rows + 1;
	const line_cols = stones_on_lines ? cols : cols + 1;
	const offset     = stones_on_lines ? 0.5 : 0;

	for (let row = 0; row < line_rows; row++) {
		const y = crisp((row + offset) * cell_size);
		grid_ctx.moveTo(0, y);
		grid_ctx.lineTo(css_w, y);
	}
	for (let col = 0; col < line_cols; col++) {
		const x = crisp((col + offset) * cell_size);
		grid_ctx.moveTo(x, 0);
		grid_ctx.lineTo(x, css_h);
	}

	grid_ctx.stroke();
}

/* There are two ways to put the cells on screen and the right one depends
   entirely on how big a cell is, so both are here.

   Something worth knowing, because it is the opposite of what you would
   guess: gathering all the circles into one big Path2D and filling that
   once measured about twice as *slow* as filling each cell separately. A
   path carrying thousands of subpaths gets tessellated as a single unit,
   while small independent fills each touch only their own few pixels.
   Batching the grid lines into one stroke is still a clear win — those
   genuinely are one long path — but batching the cells is not. */
function draw_cells() {
	if (cell_size >= ROUND_CELL_MIN) draw_cells_as_circles();
	else                             draw_cells_as_pixels();

	if (armed_pattern && hover) draw_stamp_preview();
}

/* Big cells: one antialiased arc each. A few thousand of these is nothing,
   and it is the only way to get a round cell that looks round.

   The dot always sits dead centre of its cell, in every mode — it is the
   grid that moves to meet it on crossings, over in draw_grid_layer(), not
   the other way round. That keeps every dot fully on screen regardless of
   which mode is active, since "centre of a cell that is itself on screen"
   can never land outside the canvas the way "corner of the edge cells"
   would. */
function draw_cells_as_circles() {
	cell_ctx.clearRect(0, 0, css_w, css_h);
	cell_ctx.fillStyle = COLORS.cell;

	const radius = (cell_size * CELL_FILL) / 2;
	const half   = cell_size / 2;

	for (let row = 0; row < rows; row++) {
		const base = row * cols;
		const cy = row * cell_size + half;

		for (let col = 0; col < cols; col++) {
			const a = age[base + col];
			if (a === 0) continue;          // never lived, or done fading

			cell_ctx.globalAlpha = AGE_ALPHA[a];
			cell_ctx.beginPath();
			cell_ctx.arc(col * cell_size + half, cy, radius, 0, TAU);
			cell_ctx.fill();
		}
	}
	cell_ctx.globalAlpha = 1;
}

/* Small cells: once a cell is only a few pixels across, the cost of asking
   the canvas to fill it dwarfs the handful of pixels it actually covers —
   measured around 0.4µs per fillRect, so a fully zoomed-out board burns
   ~70ms a frame on call overhead alone. Writing the pixels into an
   ImageData and uploading it in one go is about eight times quicker, and
   at two or three pixels a cell there is no antialiasing to miss. */
let pixel_buf = null;

function draw_cells_as_pixels() {
	const width  = el.cells.width;          // device pixels: ImageData
	const height = el.cells.height;         // ignores the context transform
	if (!pixel_buf || pixel_buf.width !== width || pixel_buf.height !== height)
		pixel_buf = cell_ctx.createImageData(width, height);

	const px = pixel_buf.data;
	px.fill(0);                             // one memset, clears to transparent

	const step_px = cell_size * dpr;
	const side = Math.max(1, Math.round(cell_size * CELL_FILL * dpr));
	const inset = (step_px - side) / 2;
	const { r: red, g: green, b: blue } = CELL_RGB;

	for (let row = 0; row < rows; row++) {
		const base = row * cols;
		const y0 = Math.round(row * step_px + inset);
		const y1 = Math.min(height, y0 + side);

		for (let col = 0; col < cols; col++) {
			const a = age[base + col];
			if (a === 0) continue;

			const x0 = Math.round(col * step_px + inset);
			const x1 = Math.min(width, x0 + side);

			for (let y = y0; y < y1; y++) {
				let o = (y * width + x0) * 4;
				for (let x = x0; x < x1; x++) {
					px[o]     = red;
					px[o + 1] = green;
					px[o + 2] = blue;
					px[o + 3] = a;          // ImageData alpha is straight, not
					o += 4;                 // premultiplied, so age drops in
				}
			}
		}
	}

	cell_ctx.putImageData(pixel_buf, 0, 0);
}

/* ghost of the pattern that is about to be dropped */
function draw_stamp_preview() {
	const cells = armed_pattern.cells;
	const origin_row = hover.row - (armed_pattern.rows >> 1);
	const origin_col = hover.col - (armed_pattern.cols >> 1);

	const radius = (cell_size * CELL_FILL) / 2;
	const round  = cell_size >= ROUND_CELL_MIN;
	const half   = cell_size / 2;

	cell_ctx.globalAlpha = 0.4;
	for (const [dr, dc] of cells) {
		const spot = locate(origin_row + dr, origin_col + dc);
		if (!spot) continue;
		const cx = spot.col * cell_size + half;
		const cy = spot.row * cell_size + half;
		if (round) {
			cell_ctx.beginPath();
			cell_ctx.arc(cx, cy, radius, 0, TAU);
			cell_ctx.fill();
		} else {
			cell_ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
		}
	}
	cell_ctx.globalAlpha = 1;
}

function render() {
	draw_cells();
	needs_render = false;
}

function request_render() {
	needs_render = true;
	schedule_frame();
}


/* ====================================================================
   layout — the board is fitted to the window, never the other way round
   ==================================================================== */

/* Two modes, and neither one can overflow the window:

     fit window   you pick the cell size, rows/cols follow from how many
                  fit in the space left over below the control bar
     fixed size   you pick rows/cols, and the cell size is whatever makes
                  the whole board visible                                */
function compute_layout() {
	// In fit mode the board is floored to whole cells and can never spill,
	// so no scrollbar is possible. Only a fixed board can outgrow the
	// window. Switch that on *before* measuring, so the space the scrollbar
	// gutter takes is already accounted for in what we are about to measure
	// — deciding it afterwards would leave the board a gutter too wide.
	el.stage.classList.toggle("scrollable", !fit_window);

	const avail_w = Math.max(1, el.stage.clientWidth);
	const avail_h = Math.max(1, el.stage.clientHeight);

	if (fit_window) {
		cell_size = zoom;
		cols = Math.max(MIN_DIM, Math.floor(avail_w / cell_size));
		rows = Math.max(MIN_DIM, Math.floor(avail_h / cell_size));
	} else {
		rows = fixed_rows;
		cols = fixed_cols;
		cell_size = Math.max(MIN_CELL, Math.min(avail_w / cols, avail_h / rows));
	}

	css_w = cols * cell_size;
	css_h = rows * cell_size;
}

/* Size the backing store to the *device* pixels we actually occupy and
   scale the context to match. Without this the canvas is stretched by
   the compositor on any hidpi display and everything looks faintly
   out of focus. */
function apply_canvas_size() {
	dpr = window.devicePixelRatio || 1;

	for (const canvas of [el.grid, el.cells]) {
		canvas.style.width  = css_w + "px";
		canvas.style.height = css_h + "px";
		canvas.width  = Math.round(css_w * dpr);
		canvas.height = Math.round(css_h * dpr);
	}

	// setting .width wipes the context state, so the transform goes last
	grid_ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	cell_ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

/* Fresh buffers at the new size, with whatever was on the old board
   copied across. Centred, so zooming out grows the margins around your
   pattern instead of pinning it to the top-left corner. */
function allocate(prev) {
	const n = rows * cols;
	const new_cur   = new Uint8Array(n);
	const new_age   = new Uint8Array(n);
	const new_saved = new Uint8Array(n);

	if (prev && prev.cur) {
		const dr = ((rows - prev.rows) / 2) | 0;
		const dc = ((cols - prev.cols) / 2) | 0;

		for (let r = 0; r < prev.rows; r++) {
			const nr = r + dr;
			if (nr < 0 || nr >= rows) continue;
			for (let c = 0; c < prev.cols; c++) {
				const nc = c + dc;
				if (nc < 0 || nc >= cols) continue;
				const from = r * prev.cols + c;
				const to   = nr * cols + nc;
				new_cur[to]   = prev.cur[from];
				new_age[to]   = prev.age[from];
				new_saved[to] = prev.saved[from];
			}
		}
	}

	cur = new_cur;
	age = new_age;
	saved = new_saved;
	nxt = new Uint8Array(n);
	counts = new Uint8Array(n);
	cell_count = n;
}

function relayout() {
	const prev = cur ? { rows, cols, cur, age, saved } : null;
	const prev_cell = cell_size;
	const prev_dpr = dpr;

	compute_layout();

	const dims_changed  = !prev || prev.rows !== rows || prev.cols !== cols;
	const scale_changed = cell_size !== prev_cell ||
	                      (window.devicePixelRatio || 1) !== prev_dpr;

	if (dims_changed) {
		allocate(prev);
		count_population();
	}

	// Skipping this when nothing actually changed keeps a redundant resize
	// notification cheap, and stops any scrollbar-appears/board-shrinks
	// feedback loop from oscillating.
	if (dims_changed || scale_changed) {
		apply_canvas_size();
		draw_grid_layer();
		request_render();
	}

	sync_inputs();
	show_counters();

	// Deal the opening soup here rather than at startup, so it fills the
	// board as actually laid out. The first measurement can happen before
	// the control bar has finished reflowing, and seeding against that
	// would leave a band of empty cells around the edges.
	if (!seeded && rows > MIN_DIM && cols > MIN_DIM) {
		seeded = true;
		randomize();
	}
}


/* ====================================================================
   the run loop
   ==================================================================== */

/* requestAnimationFrame rather than setInterval: it lines up with the
   display refresh instead of tearing across it, and the browser stops
   calling us entirely while the tab is hidden. */
function schedule_frame() {
	if (raf_id === null) raf_id = requestAnimationFrame(frame);
}

function frame(now) {
	raf_id = null;

	if (running) {
		const interval = 1000 / steps_per_second;
		let taken = 0;

		// catch up if we fell behind, but cap it so a stalled tab coming
		// back to life does not try to replay thousands of generations
		while (now - last_step >= interval && taken < 4) {
			step();
			last_step += interval;
			taken++;
		}
		if (taken > 0) needs_render = true;
		if (now - last_step > interval * 4) last_step = now;
	}

	if (needs_render) render();
	if (running) schedule_frame();
}

function play() {
	if (running) return;
	running = true;
	last_step = performance.now();
	el.play.textContent = "pause";
	el.play.classList.add("on");
	schedule_frame();
}

function stop() {
	running = false;
	el.play.textContent = "play";
	el.play.classList.remove("on");
}

function toggle_play() {
	running ? stop() : play();
}


/* ====================================================================
   board operations
   ==================================================================== */

function show_counters() {
	el.gen.textContent = String(generation).padStart(5, "0");
	el.pop.textContent = String(population);
}

function snapshot() {
	saved.set(cur);
}

function clear_board() {
	stop();
	cur.fill(0);
	age.fill(0);
	saved.fill(0);
	generation = 0;
	population = 0;
	show_counters();
	request_render();
}

function reset_board() {
	stop();
	cur.set(saved);
	age.fill(0);
	for (let i = 0; i < cell_count; i++) if (cur[i]) age[i] = AGE_MAX;
	generation = 0;
	count_population();
	show_counters();
	request_render();
}

function randomize() {
	stop();
	for (let i = 0; i < cell_count; i++) {
		cur[i] = Math.random() < RANDOM_DENSITY ? 1 : 0;
		age[i] = cur[i] ? AGE_MAX : 0;
	}
	generation = 0;
	count_population();
	snapshot();
	show_counters();
	request_render();
}

function single_step() {
	stop();          // stepping while running is ambiguous, so pause first
	step();
	request_render();
}


/* ====================================================================
   patterns

   Written as little pictures so they can be read and edited in place.
   'O' is a live cell, anything else is dead.
   ==================================================================== */

const PATTERN_ART = {
	"class demo": [
		"O....",
		"O.OOO",
		"O....",
	],
	"glider": [
		".O.",
		"..O",
		"OOO",
	],
	"lightweight spaceship": [
		".O..O",
		"O....",
		"O...O",
		"OOOO.",
	],
	"pulsar": [
		"..OOO...OOO..",
		".............",
		"O....O.O....O",
		"O....O.O....O",
		"O....O.O....O",
		"..OOO...OOO..",
		".............",
		"..OOO...OOO..",
		"O....O.O....O",
		"O....O.O....O",
		"O....O.O....O",
		".............",
		"..OOO...OOO..",
	],
	"r-pentomino": [
		".OO",
		"OO.",
		".O.",
	],
	"acorn": [
		".O.....",
		"...O...",
		"OO..OOO",
	],
	"diehard": [
		"......O.",
		"OO......",
		".O...OOO",
	],
	"gosper glider gun": [
		"........................O...........",
		"......................O.O...........",
		"............OO......OO............OO",
		"...........O...O....OO............OO",
		"OO........O.....O...OO..............",
		"OO........O...O.OO....O.O...........",
		"..........O.....O.......O...........",
		"...........O...O....................",
		"............OO......................",
	],
};

/* turn the pictures into {rows, cols, cells:[[dr,dc],...]} */
const PATTERNS = {};
for (const [name, art] of Object.entries(PATTERN_ART)) {
	const cells = [];
	let width = 0;
	art.forEach((line, r) => {
		width = Math.max(width, line.length);
		for (let c = 0; c < line.length; c++)
			if (line[c] === "O") cells.push([r, c]);
	});
	PATTERNS[name] = { rows: art.length, cols: width, cells };
}

function build_pattern_menu() {
	const none = document.createElement("option");
	none.value = "";
	none.textContent = "draw cells";
	el.pattern.append(none);

	for (const name of Object.keys(PATTERNS)) {
		const option = document.createElement("option");
		option.value = name;
		option.textContent = name;
		el.pattern.append(option);
	}
}

function stamp(pattern, row, col) {
	const origin_row = row - (pattern.rows >> 1);
	const origin_col = col - (pattern.cols >> 1);

	for (const [dr, dc] of pattern.cells) {
		const spot = locate(origin_row + dr, origin_col + dc);
		if (!spot) continue;
		const i = spot.row * cols + spot.col;
		cur[i] = 1;
		age[i] = AGE_MAX;
	}
	count_population();
	snapshot();
	show_counters();
	request_render();
}

function arm_pattern(name) {
	armed_pattern = PATTERNS[name] || null;
	el.cells.classList.toggle("stamping", armed_pattern !== null);
	request_render();
}


/* ====================================================================
   pointer input — click or drag to paint, click to stamp
   ==================================================================== */

/* Map a board coordinate through the edge behaviour. Returns null when
   the cell falls outside a non-wrapping board. */
function locate(row, col) {
	if (wrap_edges) {
		row = ((row % rows) + rows) % rows;
		col = ((col % cols) + cols) % cols;
		return { row, col };
	}
	if (row < 0 || row >= rows || col < 0 || col >= cols) return null;
	return { row, col };
}

/* Which cell is under this pointer event? Clamped, because the pointer
   can legitimately sit a fraction of a pixel outside the canvas and an
   unclamped index would read straight off the end of the array. */
function cell_at(event) {
	const box = el.cells.getBoundingClientRect();
	const x = (event.clientX - box.left) * (css_w / box.width);
	const y = (event.clientY - box.top)  * (css_h / box.height);

	const col = Math.min(cols - 1, Math.max(0, Math.floor(x / cell_size)));
	const row = Math.min(rows - 1, Math.max(0, Math.floor(y / cell_size)));
	return { row, col };
}

let painting = false;
let paint_to = 1;          // are we drawing cells or erasing them?
let paint_last = null;     // previous cell, so fast drags do not skip

function paint(row, col) {
	const i = row * cols + col;
	if (cur[i] === paint_to) return;
	cur[i] = paint_to;
	age[i] = paint_to ? AGE_MAX : 0;
	population += paint_to ? 1 : -1;
}

/* A quick drag fires pointermove every few cells, so join consecutive
   samples with a straight line instead of leaving gaps. */
function paint_line(from, to) {
	const steps = Math.max(Math.abs(to.row - from.row), Math.abs(to.col - from.col));
	if (steps === 0) { paint(to.row, to.col); return; }

	for (let s = 1; s <= steps; s++) {
		const row = Math.round(from.row + ((to.row - from.row) * s) / steps);
		const col = Math.round(from.col + ((to.col - from.col) * s) / steps);
		paint(row, col);
	}
}

el.cells.addEventListener("pointerdown", (event) => {
	const at = cell_at(event);

	if (armed_pattern) {
		stamp(armed_pattern, at.row, at.col);
		return;
	}

	el.cells.setPointerCapture(event.pointerId);
	painting = true;
	// whatever the first cell is, do the opposite to it for the whole drag
	paint_to = cur[at.row * cols + at.col] ? 0 : 1;
	paint_last = at;
	paint(at.row, at.col);
	show_counters();
	request_render();
});

el.cells.addEventListener("pointermove", (event) => {
	const at = cell_at(event);

	if (painting) {
		paint_line(paint_last, at);
		paint_last = at;
		show_counters();
		request_render();
		return;
	}

	if (armed_pattern) {
		if (!hover || hover.row !== at.row || hover.col !== at.col) {
			hover = at;
			request_render();
		}
	}
});

function end_paint() {
	if (!painting) return;
	painting = false;
	paint_last = null;
	snapshot();       // reset now comes back to what you just drew
}

el.cells.addEventListener("pointerup", end_paint);
el.cells.addEventListener("pointercancel", end_paint);

el.cells.addEventListener("pointerleave", () => {
	if (hover) { hover = null; request_render(); }
});


/* ====================================================================
   controls
   ==================================================================== */

function sync_inputs() {
	// in fixed mode the zoom is derived, so park the (disabled) slider at
	// whatever cell size actually got used rather than leaving it stale
	const lo = Number(el.zoom.min), hi = Number(el.zoom.max);
	el.zoom.value = String(fit_window
		? zoom
		: Math.round(Math.min(hi, Math.max(lo, cell_size))));
	el.zoom_out.textContent = String(Math.round(cell_size));

	el.speed.value = String(steps_per_second);
	el.speed_out.textContent = steps_per_second + "/s";

	el.trail.value = String(trail_percent);
	el.trail_out.textContent = trail_percent === 0 ? "off" : trail_percent + "%";

	// in fit mode these are a readout of what actually fitted
	el.rows.value = String(rows);
	el.cols.value = String(cols);
	el.rows.disabled = fit_window;
	el.cols.disabled = fit_window;
	el.zoom.disabled = !fit_window;

	el.fit.checked = fit_window;
	el.wrap.checked = wrap_edges;
	el.crossings.checked = stones_on_lines;
	el.rule.value = rule_text;
	el.palette.value = palette;
}

el.step.addEventListener("click", single_step);
el.play.addEventListener("click", toggle_play);
el.reset.addEventListener("click", reset_board);
el.clear.addEventListener("click", clear_board);
el.random.addEventListener("click", randomize);

el.zoom.addEventListener("input", () => {
	zoom = Number(el.zoom.value);
	relayout();
	write_url();
});

el.speed.addEventListener("input", () => {
	steps_per_second = Number(el.speed.value);
	el.speed_out.textContent = steps_per_second + "/s";
	last_step = performance.now();   // apply the new rate from here on
	write_url();
});

el.trail.addEventListener("input", () => {
	trail_percent = Number(el.trail.value);
	trail_decay = trail_percent / 100;
	el.trail_out.textContent = trail_percent === 0 ? "off" : trail_percent + "%";
	if (trail_decay <= 0) {
		for (let i = 0; i < cell_count; i++) age[i] = cur[i] ? AGE_MAX : 0;
		request_render();
	}
	write_url();
});

el.fit.addEventListener("change", () => {
	fit_window = el.fit.checked;
	// leaving fit mode keeps whatever is on screen right now, so the board
	// does not jump the moment you untick the box
	if (!fit_window) { fixed_rows = rows; fixed_cols = cols; }
	relayout();
	write_url();
});

el.wrap.addEventListener("change", () => {
	wrap_edges = el.wrap.checked;
	write_url();
});

el.crossings.addEventListener("change", () => {
	stones_on_lines = el.crossings.checked;
	// the crossings mode moves the *grid* lines, which live on their own
	// canvas that is only ever repainted on resize or a palette change —
	// this needs to join that list too, or the toggle does nothing
	// visible until something else happens to force a redraw
	draw_grid_layer();
	request_render();
	write_url();
});

/* typing a size means you want that exact size, so drop out of fit mode
   and let relayout work out the zoom that shows all of it */
function commit_dimensions() {
	fixed_rows = clamp_int(el.rows.value, MIN_DIM, 600, rows);
	fixed_cols = clamp_int(el.cols.value, MIN_DIM, 600, cols);
	fit_window = false;
	relayout();
	write_url();
}

for (const input of [el.rows, el.cols])
	input.addEventListener("change", commit_dimensions);

el.rule.addEventListener("input", () => {
	const ok = apply_rule(el.rule.value);
	el.rule.classList.toggle("invalid", !ok);
	if (ok) write_url();
});

el.pattern.addEventListener("change", () => arm_pattern(el.pattern.value));

/* Swap the whole re-skin: set data-palette, re-read the CSS variables it
   changes, then repaint both layers, since the grid layer is normally
   only ever redrawn on resize. */
function apply_palette(name) {
	palette = PALETTES.includes(name) ? name : "";
	if (palette) document.documentElement.dataset.palette = palette;
	else         delete document.documentElement.dataset.palette;

	read_theme();
	draw_grid_layer();
	request_render();
}

el.palette.addEventListener("change", () => {
	apply_palette(el.palette.value);
	write_url();
});

function clamp_int(value, lo, hi, fallback) {
	const n = parseInt(value, 10);
	if (!Number.isFinite(n)) return fallback;
	return Math.min(hi, Math.max(lo, n));
}


/* ====================================================================
   keyboard
   ==================================================================== */

document.addEventListener("keydown", (event) => {
	if (event.metaKey || event.ctrlKey || event.altKey) return;

	// let the settings boxes have their keystrokes
	const tag = event.target && event.target.tagName;
	if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") {
		if (event.key === "Escape") event.target.blur();
		return;
	}

	switch (event.key) {
		case " ":          event.preventDefault(); toggle_play();      break;
		case "n":
		case "ArrowRight": single_step();                              break;
		case "p":          play();                                     break;
		case "s":          stop();                                     break;
		case "r":          reset_board();                              break;
		case "x":          clear_board();                              break;
		case "?":          randomize();                                break;

		case "+":
		case "=":          nudge(el.speed,  +5);                       break;
		case "-":          nudge(el.speed,  -5);                       break;
		case "]":          nudge(el.trail,  +5);                       break;
		case "[":          nudge(el.trail,  -5);                       break;
		case ".":          nudge(el.zoom,   +2);                       break;
		case ",":          nudge(el.zoom,   -2);                       break;

		case "t":
			// toggle the trail, remembering where it was set
			nudge_to(el.trail, trail_percent > 0 ? 0 : (remembered_trail || DEFAULTS.trail));
			break;

		case "w":
			el.wrap.checked = !el.wrap.checked;
			el.wrap.dispatchEvent(new Event("change"));
			break;

		case "g":
			el.crossings.checked = !el.crossings.checked;
			el.crossings.dispatchEvent(new Event("change"));
			break;

		case "Escape":
			el.pattern.value = "";
			arm_pattern("");
			break;
	}
});

function nudge(input, delta) {
	nudge_to(input, Number(input.value) + delta);
}

function nudge_to(input, value) {
	const lo = Number(input.min), hi = Number(input.max);
	if (input === el.trail && trail_percent > 0) remembered_trail = trail_percent;
	input.value = String(Math.min(hi, Math.max(lo, value)));
	input.dispatchEvent(new Event("input"));
}


/* ====================================================================
   url state — the address bar stays a shareable description of the
   board, but it is no longer the only way to change it
   ==================================================================== */

let url_timer = null;

function write_url() {
	// dragging a slider fires constantly; replaceState is rate limited in
	// some browsers, so coalesce the writes
	clearTimeout(url_timer);
	url_timer = setTimeout(() => {
		const p = new URLSearchParams();

		if (fit_window) {
			p.set("fit", "1");
			if (zoom !== DEFAULTS.cell) p.set("cell", String(zoom));
		} else {
			if (fixed_rows !== DEFAULTS.rows) p.set("rows", String(fixed_rows));
			if (fixed_cols !== DEFAULTS.cols) p.set("cols", String(fixed_cols));
		}
		if (rule_text !== DEFAULTS.rule)        p.set("rule", rule_text);
		if (!wrap_edges)                        p.set("wrap", "0");
		if (stones_on_lines)                    p.set("dots", "cross");
		if (trail_percent !== DEFAULTS.trail)   p.set("trail", String(trail_percent));
		if (steps_per_second !== DEFAULTS.speed) p.set("speed", String(steps_per_second));
		if (palette)                            p.set("theme", palette);

		const query = p.toString();
		history.replaceState(null, "", location.pathname + (query ? "?" + query : ""));
	}, 250);
}

function read_url() {
	const p = new URLSearchParams(location.search);

	fit_window = p.get("fit") === "1";

	// ?rows= and ?cols= are independent and each fall back to the 19x19
	// default alone, so an old ?rows=100&cols=200 link still lands on
	// exactly that board — fixed mode is the default now anyway
	const want_rows = parseInt(p.get("rows"), 10);
	const want_cols = parseInt(p.get("cols"), 10);
	fixed_rows = Number.isFinite(want_rows) ? Math.min(600, Math.max(MIN_DIM, want_rows)) : DEFAULTS.rows;
	fixed_cols = Number.isFinite(want_cols) ? Math.min(600, Math.max(MIN_DIM, want_cols)) : DEFAULTS.cols;
	if (Number.isFinite(want_rows) || Number.isFinite(want_cols)) fit_window = false;

	zoom = clamp_int(p.get("cell"), Number(el.zoom.min), Number(el.zoom.max), DEFAULTS.cell);
	steps_per_second = clamp_int(p.get("speed"), 1, 60, DEFAULTS.speed);
	trail_percent = clamp_int(p.get("trail"), 0, 90, DEFAULTS.trail);
	trail_decay = trail_percent / 100;
	remembered_trail = trail_percent || DEFAULTS.trail;
	if (p.get("wrap") === "0") wrap_edges = false;
	if (p.get("dots") === "cross") stones_on_lines = true;

	if (!apply_rule(p.get("rule") || DEFAULTS.rule)) apply_rule(DEFAULTS.rule);

	// only set the attribute here; read_theme() runs afterwards in init(),
	// once, right before the first layout paints anything
	const want_theme = p.get("theme") || "";
	if (PALETTES.includes(want_theme) && want_theme) {
		palette = want_theme;
		document.documentElement.dataset.palette = palette;
	}
}


/* ====================================================================
   boot
   ==================================================================== */

/* The board is fitted into whatever space the control bar leaves behind,
   and that space moves for more reasons than a window resize: the fonts
   finish loading and reflow the bar, the settings row wraps onto a second
   line, a phone rotates. A ResizeObserver on the stage catches all of it —
   including the very first layout, which is otherwise easy to measure
   before it has settled.

   Note this runs the fit synchronously rather than deferring to a frame:
   a ResizeObserver callback is already the right moment in the frame, and
   a page opened in a background tab gets no animation frames at all, so
   anything to do with sizing must not wait for one. */
function init() {
	build_pattern_menu();
	read_url();
	read_theme();   // picks up whatever data-palette read_url() just set
	relayout();

	new ResizeObserver(relayout).observe(el.stage);

	// moving to a display with a different pixel density does not resize
	// the stage, so that one needs watching separately
	window.addEventListener("resize", relayout);

	if (document.fonts && document.fonts.ready)
		document.fonts.ready.then(relayout);
}

init();
