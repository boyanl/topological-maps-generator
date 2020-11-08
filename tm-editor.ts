import {Scrollbox} from 'pixi-scrollbox';
import * as $ from 'jquery';
import * as PIXI from 'pixi.js';
import {Graphics} from 'pixi.js';
import 'jquery-ui-dist/jquery-ui';
import * as d3 from 'd3';

interface Point {
    x: number;
    y: number;
}

interface Pointset {
    points: Point[];
    controlPointDiffs: Point[];
}

type PointSerialized = number[];

interface PointsetSerialized {
    points: PointSerialized[];
    controlPoints: PointSerialized[];
}

interface Command {
    apply: () => void;
    unapply: () => void;
}

interface Rectangle {
    x: number;
    y: number;
    width: number;
    height: number;
}

interface Segment {
    start: Point;
    end: Point;
}

interface Interval {
    start: number;
    end: number;
}

let graphics: Graphics, app: PIXI.Application;
let canvas: HTMLCanvasElement;
let scrollbox: Scrollbox;
let pointsets: Pointset[] = [],
    pointRadius = 7, controlPointRadius = 3;
let selected: Point[] = [];

let mouseDownStart: number, mouseDownCoords: Point;
let dragging = false, dragged: Point = null, dragStart: Point = null; //dragStart is the coords of the point at the start of its drag
let draggedCpInfo: {
    cpIndex: number,
    otherCpIndex: number,
    baseCps: Point[],
    point: Point,
    cpStartDiff: Point,
    otherCpStartDiff: Point
} = null; //contains information about a control point, if we're dragging one
let areaSelecting = false, selectionArea: PIXI.Rectangle = null;

const keyCallbacks: any = {}, keyState: any = {},
    repeatThreshold = 100; //in ms

let undoStack: Command[] = [], redoStack: Command[] = [];

const zoomFactor = 1.25;
let zoomLevel = 1.0;
const editorWidth = 800, editorHeight = 600, horizontalBufferPx = 150;

//Coords of the points "dragged" via keyboard (e.g. with the arrows)
let keyboardDragged: Point[] = [];


enum PointType {
    REGULAR = 1,
    SELECTED = 2,
    CONTROL_POINT = 3,
    DEBUG = 4
}

function remove<T>(arr: T[], element: T) {
    let i = arr.indexOf(element);
    arr.splice(i, 1);
}

function setupDrawing() {
    app = new PIXI.Application({ width: editorWidth, height: editorHeight, antialias: true, view: canvas });

    graphics = new PIXI.Graphics();

    const options = { boxWidth: editorWidth, boxHeight: editorHeight };
    scrollbox = new Scrollbox(options);
    scrollbox.dragScroll = false;
    scrollbox.overflow = 'auto';
    scrollbox.content.addChild(graphics);
    app.stage.addChild(scrollbox);
    //re-enable context menu - is disabled by the Viewport that's constructed by the Scrollbox
    //(since we can't customize the options passed in to it ..)
    document.body.oncontextmenu = null;

    app.renderer.backgroundColor = 0xffffff;

    graphics.interactive = true;
    graphics.hitArea = new PIXI.Rectangle(0, 0, app.renderer.width, app.renderer.height);
    let old = graphics.calculateBounds.bind(graphics);
    graphics.calculateBounds = (function () {
        old();
        const lb = { ...this._bounds}, buffer = horizontalBufferPx;
        this._bounds.clear();
        this._bounds.addFrame(this.transform, 0, 0, lb.maxX + buffer, lb.maxY + buffer);
        this._bounds.addFrame(this.transform, 0, 0, editorWidth + buffer, editorHeight);
    }).bind(graphics);


    graphics.on("click", (e: PIXI.InteractionEvent) => onMouseReleased(e));
    graphics.on("mousedown", (e: PIXI.InteractionEvent) => onMouseDown(e));
    graphics.on("mousemove", (e: PIXI.InteractionEvent) => onMouseMove(e));
    graphics.on("mouseout", (e: PIXI.InteractionEvent) => onMouseOut(e));

    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("keydown", onKeyDown);

    registerKey("Delete", deleteSelected);
    registerKey("z", e => { if (e.ctrlKey) { undo(); } });
    registerKey("y", e => { if (e.ctrlKey) { redo(); } });

    registerKey("+", zoomIn);
    registerKey("=", zoomIn); //for convenience - no need to press shift
    registerKey("-", zoomOut);

    registerArrowMovement();
    registerKey("a", e => {
        e.preventDefault();
        if(e.ctrlKey) {
            const allPts = allPoints();
            //select/deselect all
            if (selected.length !== allPts.length) {
                selected = allPoints();
            } else {
                selected = [];
            }
            repaint();
        }
    });

    loadStoredStateIfNotExpired();
    repaint();
}

function onMouseReleased(e: PIXI.InteractionEvent) {
    let coords = getCoords(e.data.global), nearest = pointNearCoords(coords);

    const mouseDownElapsed = performance.now() - mouseDownStart,
        isClick = mouseDownElapsed <= 150;

    if (isClick && isAddingNew() && nearest == null) {
        const addAfter = last(selected);
        let {pointset: ps, index: i} = addAfter != null ? findPointsetAndIndex(addAfter) : {pointset: createPointset(), index: -1};
        const currentSelected = selected;
        const command = {
            apply: () => { const added = addNewAtIndex(ps, coords, i + 1); selected = [added]; },
            unapply: () => { deleteAtIndex(ps, i + 1); selected = currentSelected;  }
        };
        doCommand(command);
    } else if (dragging) {
        dragging = false;
        if (dragged != null) {
            let from = {x : dragStart.x, y: dragStart.y}, to = coords, point = dragged;
            //refer to the point by index when applying/un-applying,
            //because the reference to the point can become invalid if it's deleted/re-created
            //(e.g. undo/redo add point)

            const command = {
                apply: () => { drag(point, to); },
                unapply: () => { drag(point, from); }
            }
            doCommand(command);

            dragged = null;
        } else if (draggedCpInfo != null) {
            const from = {x : dragStart.x, y: dragStart.y}, to = coords;
            const point = draggedCpInfo.point, {pointset: ps} = findPointsetAndIndex(point),
                i = draggedCpInfo.cpIndex, i2 = draggedCpInfo.otherCpIndex,
                baseCps = draggedCpInfo.baseCps;
            const command = {
                apply: () => { dragCp(i, i2, applyDiffs(baseCps, ps.controlPointDiffs), point, to); },
                unapply: () => { dragCp(i, i2, applyDiffs(baseCps, ps.controlPointDiffs), point, from); }
            };
            doCommand(command);
            draggedCpInfo = null;
        }
    } else if (areaSelecting) {
        areaSelecting = false;
        selectionArea = null;
        repaint();
    } else {
        //update the value of selected on mouse release (and if we didnt do anything else)
        if (!shouldAddToSelection(e)) {
            selected = [];
        }

        if (nearest) {
            if (!isSelected(nearest)) {
                selected.push(nearest);
            } else {
                remove(selected, nearest);
            }
        }

        repaint();
    }

    //clear those, since they're always set on mouse down (whether it precedes actual dragging or not)
    dragged = dragStart = null;

    mouseDownStart = -1;
    mouseDownCoords = null;
}


function onMouseDown(e: PIXI.InteractionEvent) {
    let coords = getCoords(e.data.global),
        nearest = pointNearCoords(coords),
        nearestCpInfo;

    mouseDownCoords = coords;
    mouseDownStart = performance.now();

    //First attempt to drag a control point (if any is near)
    //because they can be inside the point's visualization and then there's no way to drag them out
    if ((nearestCpInfo = infoForControlPointNearCoords(coords)) != null) {
        const {pointset: ps} = findPointsetAndIndex(nearestCpInfo.point);
        draggedCpInfo = {...nearestCpInfo,
            cpStartDiff: ps.controlPointDiffs[nearestCpInfo.cpIndex],
            otherCpStartDiff: ps.controlPointDiffs[nearestCpInfo.otherCpIndex]};
        const cps = applyDiffs(draggedCpInfo.baseCps, ps.controlPointDiffs),
            cp = cps[draggedCpInfo.cpIndex];
        dragStart = { x: cp.x, y: cp.y };
    } else if (nearest != null) {
        dragged = nearest;

        //need to copy these as the event may get reassigned
        dragStart = { x: nearest.x, y: nearest.y };
    }

    repaint();
}

function addToSelection(items: Point[]) {
    return selected = selected.concat(items.filter(p => !isSelected(p)));
}

function onMouseMove(e: PIXI.InteractionEvent) {
    const elapsed = mouseDownStart > 0 && performance.now() - mouseDownStart;
    if (!dragging && dragStart != null && elapsed >= 75) {
        dragging = true;
    }
    areaSelecting = dragStart == null && elapsed >= 150;

    if (dragged != null && dragging) {
        drag(dragged, getCoords(e.data.global));
        repaint();
    } else if(draggedCpInfo != null && dragging) {
        const coords = getCoords(e.data.global);
        const {pointset: ps} = findPointsetAndIndex(draggedCpInfo.point),
            effectiveCps = applyDiffs(draggedCpInfo.baseCps, ps.controlPointDiffs);
        dragCp(draggedCpInfo.cpIndex, draggedCpInfo.otherCpIndex, effectiveCps, draggedCpInfo.point, coords);

        repaint();
    } else if (areaSelecting) {
        const coords = getCoords(e.data.global),
            rect = makeRectangle(mouseDownCoords, coords);

        selectionArea = rect;
        const toSelect = allPoints().filter(pt => rect.contains(pt.x, pt.y));
        selected = shouldAddToSelection(e) ? addToSelection(toSelect) : toSelect;

        repaint();
    }
}

function onMouseOut(e: PIXI.InteractionEvent) {
    //clear flags related to area selection if the mouse leaves the drawing area
    //else we can't react if the mouse pointer gets released
    areaSelecting = false;
    selectionArea = null;

    repaint();
}


function makeRectangle(point1: Point, point2: Point) {
    const upperLeft = { x: Math.min(point1.x, point2.x), y: Math.min(point1.y, point2.y) },
        lowerRight = { x: Math.max(point1.x, point2.x), y: Math.max(point1.y, point2.y) };
    return new PIXI.Rectangle(upperLeft.x, upperLeft.y, lowerRight.x - upperLeft.x, lowerRight.y - upperLeft.y);
}


function isSelected(pt: Point) {
    return selected.indexOf(pt) !== -1;
}

function createPointset(): Pointset {
    const newPointset: Pointset = {points: [], controlPointDiffs: []};
    pointsets.push(newPointset);
    return newPointset;
}

function isNear(p: Point, x: number, y: number, radius?: number) {
    radius = radius || pointRadius;
    return distance(p.x, p.y, x, y) <= radius;
}

function pointNearCoords(coords: {x: number, y: number}) {
    return allPoints().find(p => isNear(p, coords.x, coords.y));
}

function findPointsetAndIndex (pt: Point): {pointset: Pointset, index: number} {
    for (let ps of pointsets) {
        const i = ps.points.indexOf(pt);
        if (i !== -1) {
            return {pointset: ps, index: i};
        }
    }
}

/*Finds data about a control point (of a selected point) near the
  specified coords.

  Returns info about the control point (i.e. its index), the other
  control point (related to the same non-control point) and the "base"
  values of all control points for the current pointset (without diffs
  applied) - so we can look things up later without recomputing
  them. */
function infoForControlPointNearCoords(coords: Point) {
    const baseCpsMap = new Map();
    for (let pt of selected) {
        const {pointset: ps, index: i} = findPointsetAndIndex(pt);
        let baseCps = baseCpsMap.get(ps);
        if (baseCps == null) {
            baseCpsMap.set(ps, baseCps = getBaseControlPoints(ps));
        }
        const effectiveCps = applyDiffs(baseCps, ps.controlPointDiffs),
            cpsForPoint = getControlPointsForPoint(ps, i, effectiveCps).filter(nonNull),
            nearbyCp = cpsForPoint.find(p => isNear(p, coords.x, coords.y, controlPointRadius));
        if (nearbyCp) {
            const otherCp = cpsForPoint.find(p => p != nearbyCp);
            return {
                cpIndex: effectiveCps.indexOf(nearbyCp),
                otherCpIndex: (otherCp != null ? effectiveCps.indexOf(otherCp) : null),
                baseCps: baseCps,
                point: pt
            };
        }
    }
}

function shouldAddToSelection(event: PIXI.InteractionEvent) {
    return event.data.originalEvent.ctrlKey == true;
}

function isAddingNew() {
    return true;
}

function isDisplayingPoints() {
    return true;
}

function getCoords(e: Point) {
    return { x: (e.x + scrollbox.scrollLeft) / zoomLevel, y: (e.y + scrollbox.scrollTop) / zoomLevel };
}

function shiftPoints(pts: Point[], {x, y}: {x?: number, y?: number}) {
    pts.forEach(p => {
        p.x += x || 0;
        p.y += y || 0;
    });
}

function download(data: any, filename: string, type: string) {
    var file = new Blob([data], {type: type});
    if (window.navigator.msSaveOrOpenBlob) // IE10+
        window.navigator.msSaveOrOpenBlob(file, filename);
    else { // Others
        var a = document.createElement("a"),
            url = URL.createObjectURL(file);
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        setTimeout(function() {
            document.body.removeChild(a);
            window.URL.revokeObjectURL(url);
        }, 0);
    }
}

function allPoints(ptsets?: Pointset[]): Point[] {
    ptsets = ptsets || pointsets;
    return ptsets.flatMap(ps => ps.points);
}

function pointsetToSerializedForm(pointset: Pointset, range: Rectangle) {
    //points are {x: , y: } dicts, persisted representation is expected to have [x, y] arrays instead
    const ptAsArray = (pt: Point) => [pt.x, pt.y], pts = pointset.points;

    if (pts.length > 1) {
        const cps = getEffectiveControlPoints(pointset),
            data = {"points": getNormalizedPoints(pts, range).map(ptAsArray),
                "controlPoints": getNormalizedPoints(cps, range).map(ptAsArray)}
        return data;
    }
    return {};
}

function convertToPersistedRepresentation(pointsets: Pointset[]) {
    const range = getBounds(allPoints(pointsets)),
        nonEmpty = (ps: Pointset) => ps.points.length > 0;
    return {
        pointsets: pointsets.filter(nonEmpty).map(ps => pointsetToSerializedForm(ps, range)),
        width: range.width,
        height: range.height
    }
}

function serializePointsets(pointsets: Pointset[]) {
    return JSON.stringify(convertToPersistedRepresentation(pointsets));
}

function setupFileOps() {
    $("#existing_terrain").change(function(e) {
        const file = (this as HTMLInputElement).files[0];
        parseTerrainFile(file, showTerrain);
        $(this).val(null);
    })

    $("#save_as").on("click",function(e) {
        download(serializePointsets(pointsets), "terrain.json", "application/json");
    });
}

function copyToClipboard(text: string) {
    navigator.clipboard.writeText(text)
        .catch(err => console.error("Couldn't copy spline representation to clipboard", err));
}

function setupCopyAndImportOps() {
    $("#copy_to_clipboard").on("click", function(e) {
        copyToClipboard(serializePointsets(pointsets));
    });

    $("#import_from_text").on("click", function(e) {
        $("#do_import").on("click", function(e) {
            const textarea = $("#import_dialog textarea");
            const text = textarea.val();

            $("#import_dialog").dialog("close");
            showTerrain(parseJsonRepresentation(text));
        });
    });
}

$(() => {
    canvas = $("#spline").get(0) as HTMLCanvasElement;
    setupDrawing();
});


function showTerrain(terrain: Pointset[]) {
    pointsets = terrain;
    saveCurrentState();

    //What to do about undo/redo??
    repaint();
}


function parseTerrainFile(file: File, onSuccess: (res: any) => void) {
    getFileContents(file, raw => onSuccess(parseJsonRepresentation(raw)));
}

function getControlPointsFromTangents(points: Point[], tangents: Point[]) {
    let res = [];
    for (let i = 0; i < points.length - 1; ++i) {
        const p1 = points[i], p2 = points[i+1],
            t1 = tangents[i], t2 = tangents[i+1];
        const cp1  = {x: p1.x + t1.x, y: p1.y + t1.y},
            cp2 = {x: p2.x - t2.x, y: p2.y - t2.y};
        res.push(cp1, cp2);
    }
    return res;
}


function convertPersistedRepresentation(data: { pointsets: PointsetSerialized[], width: number, height: number}) {
    const bounds = { x: 50, y: 100, width: data.width, height: data.height };
    const toPt = ([l, t]: number[]) => ({x: l, y: t});
    const scaleFn = (p: Point) => ({x: p.x * bounds.width + bounds.x,
        y: p.y * bounds.height + bounds.y});

    return data.pointsets.map(ps => {
        const points = ps.points.map(p => scaleFn(toPt(p)));
        const cps = getControlPointsFromTangents(points, monotoneTangents(points))

        return {
            points: points,
            controlPointDiffs: ps.controlPoints.map(p => scaleFn(toPt(p))).map(({x, y}, i) => {
                return {x: x - cps[i].x, y: y - cps[i].y};
            })
        }
    });
}

function parseJsonRepresentation(raw: any): Pointset[] {
    return convertPersistedRepresentation(JSON.parse(raw));
}


function getFileContents(file: File, onSuccess: (res: any) => void, onFail?: (err: any) => void) {
    let reader = new FileReader();
    reader.readAsText(file, "UTF-8");
    reader.onload = e => { onSuccess(e.target.result); }
    reader.onerror = e => { if (onFail) { onFail(e); } }
}

function distance(x1: number, y1: number, x2: number, y2: number) {
    return ((x1 - x2) ** 2 + (y1 - y2) ** 2) ** 0.5;
}

function distancePts(p1: Point, p2: Point) {
    return distance(p1.x, p1.y, p2.x, p2.y);
}

function pt(x: number, y: number) {
    return {x: x, y: y};
}

function bezierCurve(x1: number, y1: number, x2: number, y2: number, x: number, y: number, g?: PIXI.Graphics) {
    g = g || graphics;
    g.bezierCurveTo(x1, y1, x2, y2, x, y);
}

function moveTo(x: number, y: number, g?: PIXI.Graphics) {
    g = g || graphics;
    g.moveTo(x, y);
}

function nonNull(x: any) {
    return x != null;
}

function lines(points: Point[], g?: PIXI.Graphics, color?: number) {
    g = g || graphics;
    color = color || 0;
    const oldColor = g.line.color, width = g.line.width;
    g.lineStyle(width, color);
    if (points.length === 0) return;
    const p0 = points[0];
    g.moveTo(p0.x, p0.y);
    for (let i = 1; i < points.length; ++i) {
        g.lineTo(points[i].x, points[i].y);
    }

    g.lineTo(p0.x, p0.y);
    g.lineStyle(width, oldColor);
}

function curveHermite(points: Point[], tangents: Point[], g?: PIXI.Graphics) {
    g = g || graphics;
    let p0 = points[0], t0 = tangents[0];

    if (tangents.length > 1) {
        let p = p0, t = t0;

        for (let i = 1; i < tangents.length; i++) {
            p0 = p;
            t0 = t;
            p = points[i];
            t = tangents[i];
            moveTo(p0.x, p0.y);
            bezierCurve(p0.x + t0.x, p0.y + t0.y,
                p.x - t.x, p.y - t.y,
                p.x, p.y);
        }
    }
}

function curveHermiteCps(points: Point[], cps: Point[], g?: PIXI.Graphics) {
    g = g || graphics;
    if (points.length < 2 || cps.length < points.length * 2 - 2) {
        return;
    }
    if (points.length > 1) {
        for (let i = 0; i < points.length - 1; ++i) {
            let p0 = points[i], p1 = points[i+1];
            let cp0 = cps[2*i], cp1 = cps[2*i + 1];
            moveTo(p0.x, p0.y, g);
            bezierCurve(cp0.x, cp0.y,
                cp1.x, cp1.y,
                p1.x, p1.y, g);
        }
    }
}

interface FakeCanvasRenderingContext extends CanvasRenderingContext2D {
    points(): Point[];
    controlPoints(): Point[];
}

function getFakeContext(): FakeCanvasRenderingContext {
    let points: Point[] = [], controlPoints: Point[] = [];
    return {
        moveTo(x: number, y: number) {
            points.push({x, y});
        },
        bezierCurveTo(cp1x: number, cp1y: number, cp2x: number, cp2y: number, x: number, y: number) {
            points.push({x, y});
            controlPoints.push({x: cp1x, y: cp1y});
            controlPoints.push({x: cp2x, y: cp2y});
        },

        points(): Point[] {
            return points;
        },

        controlPoints(): Point[] {
            return controlPoints;
        },
        closePath() {
        },

        lineTo(x: number, y: number) {
            points.push({x, y});
        }
    } as FakeCanvasRenderingContext; // the unimplemented members aren't needed for now
}


function usingD3Curves(points: Point[], curveFactory: d3.CurveFactory): [Point[], Point[]] {
    const ctx = getFakeContext();
    const generator = curveFactory(ctx);
    generator.lineStart();
    for (let p of points) {
        generator.point(p.x, p.y);
    }
    generator.lineEnd();
    return [ctx.points(), ctx.controlPoints()];
}

function getClosedBasisCurvePoints(points: Point[]): [Point[], Point[]] {
    const pts: Point[] = [], cps: Point[] = [];
    if (points.length <= 3) {
        return [pts, cps];
    }
    const [f, s, t] = points.slice(0, 3);
    pts.push({x: (f.x + 4*s.x + t.x)/6, y: (f.y + 4*s.y + t.y)/6});
    let p0: Point, p1: Point;
    p0 = s; p1 = t;
    const addPoint = (p: Point) => {
        cps.push({x: (2*p0.x + p1.x)/3, y: (2*p0.y + p1.y)/3 });
        cps.push({x: (p0.x + 2*p1.x)/3, y: (p0.y + 2*p1.y)/3 });
        pts.push({ x: (p0.x + 4*p1.x + p.x)/6, y: (p0.y + 4*p1.y + p.y)/6 });
        p0 = p1;
        p1 = p;
    }
    for (let i = 3; i < points.length; ++i) {
        addPoint(points[i]);
    }
    addPoint(f);
    addPoint(s);
    addPoint(t);
    return [pts, cps];
}

function curvePoints(points: Point[]): [Point[], Point[]] {
    return usingD3Curves(points, d3.curveBasisClosed);
}

// TODO: Pass in the result of curvePoints(...) to avoid re-computation?
function curves(points: Point[], g?: PIXI.Graphics, color?: number) {
    g = g || graphics;
    color = color || 0;
    const [ps, cps] = curvePoints(points);
    const oldColor = g.line.color, width = g.line.width;
    g.lineStyle(width, color);
    curveHermiteCps(ps, cps);
    g.lineStyle(width, oldColor);
}

/* Points is an array of objects with fields {x, y} */
function monotoneTangents(points: Point[]) {
    let tangents = [],
        d: number[] = [],
        m: number[] = [],
        dx: number[] = [],
        k = 0;

    /* Compute the slopes of the secant lines between successive points. */
    for (k = 0; k < points.length-1; k++) {
        d[k] = (points[k+1].y - points[k].y)/(points[k+1].x - points[k].x);
    }

    /* Initialize the tangents at every point as the average of the secants. */
    m[0] = d[0];
    dx[0] = points[1].x - points[0].x;
    for (k = 1; k < points.length - 1; k++) {
        m[k] = (d[k-1]+d[k])/2;
        dx[k] = (points[k+1].x - points[k-1].x)/2;
    }
    m[k] = d[k-1];
    dx[k] = (points[k].x - points[k-1].x);

    /* Step 3. Very important, step 3. Yep. Wouldn't miss it. */
    for (k = 0; k < points.length - 1; k++) {
        if (d[k] == 0) {
            m[ k ] = 0;
            m[k+1] = 0;
        }
    }

    /* Step 4 + 5. Out of 5 or more steps. */
    for (k = 0; k < points.length - 1; k++) {
        if ((Math.abs(m[k]) < 1e-5) || (Math.abs(m[k+1]) < 1e-5)) continue;
        var ak = m[k] / d[k],
            bk = m[k + 1] / d[k],
            s = ak * ak + bk * bk; // monotone constant (?)
        if (s > 9) {
            var tk = 3 / Math.sqrt(s);
            m[k] = tk * ak * d[k];
            m[k + 1] = tk * bk * d[k];
        }
    }

    var len;
    for (var i = 0; i < points.length; i++) {
        len = 1 + m[i] * m[i]; // pv.vector(1, m[i]).norm().times(dx[i]/3)
        tangents.push({x: dx[i] / 3 / len, y: m[i] * dx[i] / 3 / len});
    }

    return tangents;
}

function bezierCurvePointAt(p0: Point, cp0: Point, cp1: Point, p1: Point, t: number): Point {
    return vec_plus(vec_mult(p0, Math.pow(1-t, 3)),
        vec_mult(cp0, 3*Math.pow(1-t, 2) * t),
        vec_mult(cp1, 3*(1-t)*t*t),
        vec_mult(p1, t*t*t));
}

function getBoundingRect(points: Point[]) {
    let minx = Math.min(...points.map(p => p.x)), miny = Math.min(...points.map(p => p.y)),
        maxx = Math.max(...points.map(p => p.x)), maxy = Math.max(...points.map(p => p.y));
    return {x: minx, y: miny, width: maxx - minx, height: maxy - miny};
}

function getNormalizedPoints(points: Point[], bounds: Rectangle) {
    return points.map(p => ({x: (p.x - bounds.x)/bounds.width,
        y: (p.y - bounds.y)/bounds.height }));
}

function drawPoint(point: Point, radius: number, pointType: PointType, g?: PIXI.Graphics) {
    g = g || graphics;

    const [fillColor, lineColor] = (() => {
        switch(pointType) {
            case PointType.REGULAR:
                return [0xd4e1f4, 0x5f8dd8];
            case PointType.SELECTED:
                return [0xf9d77a, 0xefbf3b];
            case PointType.CONTROL_POINT:
                return [0xdbc1e3, 0xb245d1];
            case PointType.DEBUG:
                return [0x5f8a45, 0x394d2d];
            default:
                console.error("Unsupported point type: ", pointType);
                return null;
        }
    })();

    const lineWidth = 1;
    let prevWidth = g.line.width, prevColor = g.line.color;

    g.lineStyle(lineWidth, lineColor);
    g.beginFill(fillColor);
    g.drawCircle(point.x, point.y, radius);
    g.endFill();

    g.lineStyle(prevWidth, prevColor);
}

function drawText(coords: Point, text: string) {
    let pixiText = new PIXI.Text(text, {fontSize: 16});
    pixiText.x = coords.x - scrollbox.scrollLeft;
    pixiText.y = coords.y - scrollbox.scrollTop;
    app.stage.addChild(pixiText);
}

function drawRect(rect: Rectangle, lineColor: number, fillColor?: number, g?: PIXI.Graphics) {
    g = g || graphics;

    const lineWidth = 1;
    let prevWidth = g.line.width, prevColor = g.line.color;

    const fillAlpha = fillColor != null ? 1 : 0;
    g.lineStyle(lineWidth, lineColor);
    g.beginFill(fillColor, fillAlpha);
    g.drawRect(rect.x, rect.y, rect.width, rect.height);
    g.endFill();

    graphics.lineStyle(prevWidth, prevColor);
}

function getBounds(pts: Point[]) {
    let min_x = Math.min(...pts.map(p => p.x)), max_x = Math.max(...pts.map(p => p.x)),
        min_y = Math.min(...pts.map(p => p.y)), max_y = Math.max(...pts.map(p => p.y));
    return {x: min_x,
        y: min_y,
        width: (max_x !== min_x ? max_x - min_x : 1),
        height: (max_y !== min_y ? max_y - min_y : 1)
    };

}

function repaint() {
    app.stage.removeChildren();
    app.stage.addChild(scrollbox);
    graphics.clear();
    graphics.lineStyle(1, 0x000000);

    resetPointDescriptions();
    resetNormalizedPointDescriptions();

    const allPts = allPoints(), range = getBounds(allPts),
        marginLeft = ensureLeftMargin(allPts);


    const reordered = pointsets.map(p => ({
        points: hasSelfIntersectingParts(p.points) ? reorderClockwise(p.points) : p.points,
        controlPointDiffs: p.controlPointDiffs
    }));
    for (let ps of reordered) {
        repaintPointset(ps, range);
    }

    if (selectionArea != null) {
        drawRect(selectionArea, 0x000000);
    }

    const allPolys = reordered.map(p => p.points);
    const getUnioned = (allPolys: Point[][]) => allPolys.reduce((acc: Point[][], curr, i) => {
        if (acc.length == 0) return [curr];
        let currUnion = curr;
        let res: Point[][] = [];
        for (let i = 0; i < acc.length; ++i) {
            const el = acc[i];
            const u = polyUnion(el, currUnion);
            if (u.length == 2) {
                res.push(el);
            } else {
                currUnion = u[0];
            }

            if (i == acc.length - 1) {
                res.push(currUnion);
            }
        }
        return res;
    }, []);

    const union = getUnioned(allPolys);
    const amounts = [0, 1, 2, 3, 4].map(x => x * 20);
    const colors = [0xa5eb34, 0x65eb34, 0x34eb52, 0x34eb89, 0x34ebc3, 0x34ebe8];
    let lastUnion = union;
    let lastAmount = 0;
    const expandStepwise = (union: Point[][], totalToExpand: number, step: number) => {
        let united = union;
        if (step > 0) {
            for (let j = step; j <= totalToExpand; j += step) {
                const expanded = united.map(p => expand(p, step));
                united = getUnioned(expanded);
            }
        }
        return united;
    }
    for (let i = 0; i < amounts.length; ++i) {
        const delta = amounts[i] - lastAmount;
        const step = 1;
        let currentUnion: Point[][] = expandStepwise(lastUnion, delta, step).map(part => removeSelfIntersectingParts(part));
        currentUnion = currentUnion.map(el => {
            const result = addCollinearPoints([...el, el[0]], 300);
            return result.slice(0, result.length - 1);
        });
        for (const el of currentUnion) {
            // lines(el, graphics, colors[i]);
            curves(el, graphics, colors[i]);
        }

        lastUnion = currentUnion;
        lastAmount = amounts[i];
    }


    //scrollbox doesn't support directly modifying scrollLeft, so fiddle with its internals instead..
    scrollbox.content.left += marginLeft;
    scrollbox.update();

    // setZoom(zoomLevel); //update zoom level label
}

function addCollinearPoints(pts: Point[], maxDistance: number): Point[] {
    const withMidpoints = [];
    for (let i = 0; i < pts.length - 1; ++i) {
        const p0 = pts[i], p1 = pts[i+1];
        if (withMidpoints.length === 0) {
            withMidpoints.push(p0);
        }
        const dist = distancePts(p0, p1);
        if (distancePts(p0, p1) >= maxDistance) {
            const neededPts = Math.floor(dist / maxDistance);
            for (let j = 1; j <= neededPts; ++j) {
                const pt = vec_divide(vec_plus(vec_mult(p0, neededPts + 1 - j), vec_mult(p1, j)), neededPts + 1);
                withMidpoints.push(pt);
            }
        }
        withMidpoints.push(p1);
    }
    return withMidpoints;
}

function segments(pts: Point[]): Segment[] {
    if (pts.length < 2) {
        return [];
    }
    let res = [];
    let p0 = pts[0];
    for (let i = 1; i < pts.length; ++i) {
        res.push({ start: p0, end: pts[i] });
        p0 = pts[i];
    }
    res.push({ start: pts[pts.length - 1], end: pts[0] });
    return res;
}

function cross(v1: Point, v2: Point) {
    return v1.x*v2.y - v2.x*v1.y;
}

function isNumber(x: any): x is number {
    return typeof x === "number";
}

function isPoint(o: any): o is Point {
    return o.x != null && o.y != null;
}

function vec(p1: Point | number, p2: Point | number): Point {
    if (isNumber(p1) && isNumber(p2)) {
        return {x: p1, y: p2};
    }
    else if (isPoint(p1) && isPoint(p2)) {
        return {x: p2.x - p1.x, y: p2.y - p1.y };
    }
}

function closeTo(n: number, t: number) {
    return Math.abs(n - t) < 1e-9;
}

function intersectSegments(segment1: Segment, segment2: Segment): {u: number, v: number} {
    const {start: s1, end: e1} = segment1, r = vec(s1, e1);
    const {start: s2, end: e2} = segment2, s = vec(s2, e2);
    const numerator1 = cross(vec(s1, s2), r), denom = cross(r, s);
    if (closeTo(numerator1, 0) && closeTo(denom, 0)) {
        let dot_r_r = dot(r, r);
        let u0 = dot(vec(s1, s2), r)/dot_r_r,
            u1 = dot(vec(s1, vec_plus(s2, s)), r)/dot_r_r;
        if (dot(s, r) < 0) {
            [u0, u1] = [u1, u0];
        }
        const intervalIntersection = intersectIntervals({start: u0, end: u1}, {start: 0, end: 1});
        if (intervalIntersection != null) {
            const u = intervalIntersection.start;
            const v = (dot(vec_minus(s1, s2), s) + dot(vec_mult(r, u), s))/dot(s, s);
            if (!closeTo(intervalIntersection.start, intervalIntersection.end)) {
                // lines([segment1.start, segment1.end], graphics, 0x00ff00);
                // lines([segment2.start, segment2.end], graphics, 0x0000ff);
            }
            return {u, v};
        }
        // collinear, check for equal starts/ends, otherwise no intersection
        if (ptClose(segment1.start, segment2.start)) return {u: 0, v: 0}
        if (ptClose(segment2.start, segment1.end)) return {u: 1, v: 0};
        if (ptClose(segment1.start, segment2.end)) return {u: 0, v: 1};
        if (ptClose(segment1.end, segment2.end)) return {u: 1, v: 1};
        return null;
    } else if (closeTo(numerator1, 0) || closeTo(denom, 0)) {
        return null;
    }
    const v = numerator1 / denom, u = cross(vec(s1, s2), s) / denom;
    return {u, v};
}

function intersectIntervals(i1: Interval, i2: Interval) {
    const result = {start: Math.max(i1.start, i2.start), end: Math.min(i1.end, i2.end)};
    return validInterval(result) ? result : null;
}

function validInterval(interval: Interval) {
    return interval.start <= interval.end;
}

function vec_plus(...args: Point[]): Point {
    return args.reduce((p1, p2) => ({x: p1.x + p2.x, y: p1.y + p2.y}), {x: 0, y: 0});
}

function vec_minus(v1: Point, v2: Point): Point {
    return {x: v1.x - v2.x, y: v1.y - v2.y };
}

function vec_mult(v1: Point, t: number): Point {
    return {x: v1.x * t, y: v1.y * t };
}

function vec_divide(v1: Point, t: number) : Point {
    return {x: v1.x / t, y: v1.y / t};
}

function distanceSq(p1: Point, p2: Point): number {
    return (p2.x - p1.x)**2 + (p2.y - p1.y)**2;
}

function ptEq(p1: Point, p2: Point): boolean {
    return p1.x === p2.x && p1.y === p2.y;
}

function ptClose(p1: Point, p2: Point): boolean {
    return closeTo(p1.x, p2.x) && closeTo(p1.y, p2.y);
}

function dot(v1: Point, v2: Point): number {
    return v1.x*v2.x + v1.y*v2.y;
}

function magnitude(v: Point): number {
    return Math.sqrt(dot(v, v));
}

function normalized(v: Point): Point {
    return vec_mult(v, 1/magnitude(v));
}

function angleBetween(v1: Point, v2: Point): number {
    const angleV2 = Math.atan2(v2.y, v2.x), angleV1 = Math.atan2(v1.y, v1.x);
    let angle = angleV2 - angleV1;
    if (angle > Math.PI) angle -= 2*Math.PI;
    else if (angle <= -Math.PI) angle += 2*Math.PI;
    return angle;
}

function areWindingClockwise(pts: Point[]): boolean {
    let sum = 0;
    for (let s of segments(pts)) {
        sum += (s.end.x - s.start.x)*(s.end.y + s.start.y);
    }
    return sum < 0;
}

function inside(poly: Point[], pt: Point) {
    const ray = {start: pt, end: ptPlus(pt, {x: 1, y: 0})};
    let intersections = 0;
    for (let s of segments(poly)) {
        const inters = intersectSegments(s, ray);
        if (inters != null && inters.u >= 0 && inters.u <= 1 && inters.v >= 0) {
            ++intersections;
        }
    }
    return intersections % 2 == 1;
}

// TODO: Add a high-level description of the separate steps in the algorithm

// TODO: Handle the case when the 2 polygons don't intersect
function polyUnion(poly1: Point[], poly2: Point[]) {
    type Graph = {p: Point, neighbours: Point[]}[];
    const addNeighbour = (graph: Graph, to: Point, neighbour: Point) => {
        let found = false;
        graph.filter(el => ptEq(el.p, to)).forEach(el => {
            found = true;
            el.neighbours.push(neighbour);
        });
        if (!found) {
            graph.push({p: to, neighbours: [neighbour]});
        }
    }
    const linkPoints = (graph: Graph, p1: Point, p2: Point) => {
        addNeighbour(graph, p1, p2);
        addNeighbour(graph, p2, p1);
    };
    const removeNeighbour = (graph: Graph, to: Point, neighbour: Point) => {
        graph.filter(el => ptEq(el.p, to)).forEach(el => {
            for (let i = 0; i < el.neighbours.length; ++i) {
                if (ptEq(neighbour, el.neighbours[i])) {
                    el.neighbours.splice(i, 1);
                }
            }
        });
    }
    const unlinkPoints = (graph: Graph, p1: Point, p2: Point) => {
        removeNeighbour(graph, p1, p2);
        removeNeighbour(graph, p2, p1);
    };
    const getNeighbours = (graph: Graph, p: Point) => {
        return graph.find(el => ptEq(el.p, p)).neighbours;
    }

    const furthestFromLowestLeft = (pts: Point[]) => {
        let minx = pts.map(p => p.x).reduce((a, b) => Math.min(a, b)),
            maxy = pts.map(p => p.y).reduce((a, b) => Math.max(a, b));
        const lowerLeftCorner = {x: minx, y: maxy };
        pts.sort((a, b) => distanceSq(b, lowerLeftCorner) - distanceSq(a, lowerLeftCorner));
        return pts[0];
    }

    const poly2Graph: Graph = [];
    const segments2 = segments(poly2);
    for (let s2 of segments2) {
        linkPoints(poly2Graph, s2.start, s2.end);
    }

    let graph: Graph = [];
    /*
     * Build a graph describing the 2 polygons and any intersection points between them
     */
    const segs = segments(poly1), segs2 = segments2;
    let haveIntersection = false;
    for (let s1 of segs) {
        const intersectionPts = [];
        for (let s2 of [...segs2]) { //iterate over a copy so that iteration isn't affected by changes
            const inters = intersectSegments(s1, s2);
            if (inters != null &&
                inters.u > 0 && inters.u < 1 &&
                inters.v > 0 && inters.v < 1) {
                const v = vec(s1.start, s1.end),
                    pt = vec_plus(s1.start, vec_mult(v, inters.u));
                intersectionPts.push({ p: pt, neighbours: [s2.start, s2.end]});
                linkPoints(poly2Graph, s2.start, pt);
                linkPoints(poly2Graph, s2.end, pt);
                unlinkPoints(poly2Graph, s2.start, s2.end);
                segs2.forEach((p, i) => {
                    if (ptEq(p.start, s2.start) && ptEq(p.end, s2.end)) {
                        segs2.splice(i, 1, {start: s2.start, end: pt}, {start: pt, end: s2.end});
                    }
                });
                haveIntersection = true;
            }
        }
        let p0 = s1.start, neighb = [];
        intersectionPts.sort((a, b) => distanceSq(s1.start, a.p) - distanceSq(s1.start, b.p));
        const arr = intersectionPts.concat({p: s1.end, neighbours: []})
        for (let intersP of arr) {
            linkPoints(graph, p0, intersP.p);
            p0 = intersP.p;
            neighb = intersP.neighbours;
        }
    }
    if (!haveIntersection) {
        if (poly2.length == 0 || inside(poly1, poly2[0])) {// polygon 2 is fully inside polygon 1 (no intersection and one of its points is inside poly1) => result is poly1
            return [poly1];
        } else if (poly1.length == 0 || inside (poly2, poly1[0])) {
            return [poly2];
        }
        return [poly1, poly2];
    }


    const mergeGraphs = (g1: Graph, g2: Graph) => {
        const res = [...g1];
        for (let v2 of g2) {
            const existing = res.find(v => ptEq(v.p, v2.p));
            if (existing != null) {
                existing.neighbours = existing.neighbours.concat(v2.neighbours);
            } else {
                res.push(v2);
            }
        }
        return res;
    };
    const mergedGraph = mergeGraphs(graph, poly2Graph);
    let prevPt: Point = null;
    const result = [];
    const start = furthestFromLowestLeft(poly1.concat(poly2));
    let q = [start], visited = [start];
    const isVisited = (v: Point) => visited.find(x => ptEq(x, v)) != null;
    let clockwiseWindingOrder = null;
    while (q.length > 0) {
        const v = q[0];
        result.push(v);
        q = q.splice(1);

        // drawPoint(v, 4, PointType.DEBUG);
        let neighb = getNeighbours(mergedGraph, v);
        if (neighb.length === 2) { //ordinary point (not intersection point)
            if (clockwiseWindingOrder == null) { // need to determine winding order
                // always pick clockwise winding
                const o = areWindingClockwise([neighb[1], v, neighb[0]]) ? [neighb[1], v, neighb[0]] : [neighb[0], v, neighb[1]];
                clockwiseWindingOrder = true;

                q.push(o[2]);
                visited.push(o[2]);
            } else {
                const next = neighb.find(x => x != prevPt && !isVisited(x));
                if (next != null) {
                    q.push(next);
                    visited.push(next);
                }
            }
        } else {
            const lastSegmentVec = vec(prevPt, v);
            neighb = neighb.filter(x => x != prevPt).sort((p1, p2) => {
                const angle1 = angleBetween(lastSegmentVec, vec(v, p1)), angle2 = angleBetween(lastSegmentVec, vec(v, p2));
                return angle1 - angle2;
            });
            if (!isVisited(neighb[0])) {
                q.push(neighb[0]);
                visited.push(neighb[0]);
            }
        }
        prevPt = v;
    }
    return [result];
}

function pickClockwiseOrder(pts: Point[]) {
    if (pts.length <= 2) {
        return pts;
    }
    return areWindingClockwise(pts) ? pts : [...pts].reverse();
}

function reorderClockwise(pts: Point[]) {
    let center = vec_divide(pts.reduce((a, b) => ptPlus(a, b), pt(0, 0)), pts.length);
    const compareFn = (a: Point, b: Point) => {
        const a_center = vec(a, center);
        const b_center = vec(b, center);
        if (a_center.x >= 0 && b_center.x < 0) return -1;
        if (a_center.x < 0 && b_center.x >= 0) return 1;
        if (a_center.x === 0 && b_center.x === 0) {
            if (a_center.y >= 0 && b_center.y >= 0) {
                return b_center.y - a_center.y;
            }
        }
        const det = cross(a_center, b_center);
        if (det !== 0) {
            return det < 0 ? -1 : 1;
        }
        // points a and b are on the same line from the center
        // check which point is closer to the center
        const dist1 = distanceSq(a, center), dist2 = distanceSq(b, center);
        return dist2 - dist1;
    };
    return [...pts].sort(compareFn);
}

//Assumes clockwise winding order
function normal(segment: Segment) {
    const v = vec(segment.start, segment.end)
    const n1 = normalized(vec(-v.y, v.x)), n2 = normalized(vec(v.y, -v.x));
    return cross(v, n1) < 0 ? n1 : n2;
}

function drawNormals(pts: Point[]) {
    let i = 0;
    for (let s of segments(pickClockwiseOrder(pts))) {
        const n = normal(s);
        const p = vec_plus(vec_mult(vec_plus(s.start, s.end), 0.5), vec_mult(n, 10));
        drawPoint(p, 4, PointType.DEBUG);
        drawText(p, "" + (++i));
    }
}

function expand(pts: Point[], amount: number) {
    pts = pickClockwiseOrder(pts);
    const ptAt = (i: number) => pts[(i + pts.length) % pts.length];
    const result = [];
    for (let i = 0; i < pts.length; ++i) {
        const pt = pts[i], prevPt = ptAt(i-1), nextPt = ptAt(i+1);
        if (ptEq(pt, nextPt) || ptEq(prevPt, pt) || collinear(prevPt, pt, nextPt)) {
            continue;
        }
        const n1 = normal({start: prevPt, end: pt}), n2 = normal({start: pt, end: nextPt});

        const prevPtExp = vec_plus(prevPt, vec_mult(n1, amount)), ptExp = vec_plus(pt, vec_mult(n1, amount)),
            nextPtExp = vec_plus(nextPt, vec_mult(n2, amount));
        const ptExp2 = vec_plus(pt, vec_mult(n2, amount));
        const prevSegmentExp = {start: prevPtExp, end:  ptExp},
            nextSegmentExp = {start: nextPtExp, end: ptExp2}; //start and end deliberately swapped here
        const intersection = intersectSegments(prevSegmentExp, nextSegmentExp);
        if (intersection == null) {
            continue;
        }
        const {u, v} = intersection;
        const newPt = vec_plus(prevSegmentExp.start, vec_mult(vec(prevSegmentExp.start, prevSegmentExp.end), u));
        result.push(newPt);
    }
    return result;
}

function collinear(p1: Point, p2: Point, p3: Point) {
    return Math.abs((p2.y - p1.y)/(p2.x - p1.x) - (p3.y - p1.y)/(p3.x - p1.x)) <= 1e-6;
}

function* pairs<T>(items: T[]) {
    for (let i = 0; i < items.length; ++i) {
        for (let j = i + 1; j < items.length; ++j) {
            yield [items[i], items[j]];
        }
    }
}

function hasSelfIntersectingParts(pts: Point[]): boolean {
    for (let [s1, s2] of pairs(segments(pts))) {
        if (validIntersection(intersectSegments(s1, s2))) {
            return true;
        }
    }
    return false;
}

function removeSelfIntersectingParts(pts: Point[]): Point[] {
    pts = pickClockwiseOrder(pts);
    const result: Point[] = [];
    const segs = segments(pts);
    if (segs.length == 0) {
        return pts;
    }
    result.push(segs[0].start);
    for (let i = 0; i < segs.length; ++i) {
        const closest = range(i + 1, segs.length - 1).map(j => {
            return {index: j, intersection: intersectSegments(segs[i], segs[j]) };
        }).filter(data => {return validIntersection(data.intersection); })
        .reduce((d1, d2) => {
            if (d1.index === -1) {
                return d2;
            }
            const pt1 = getIntersectionPoint(d1.intersection, segs[i]),
                pt2 = getIntersectionPoint(d2.intersection, segs[i]);
            const distance1 = distanceSq(segs[i].start, pt1), distance2 = distanceSq(segs[i].start, pt2);
            return distance1 < distance2 ? d1 : d2;
        }, {index: -1, intersection: null});
        if (closest.index !== -1) {
            const pt = getIntersectionPoint(closest.intersection, segs[i]);
            // drawPoint(segs[i].start, 4, PointType.DEBUG);
            // drawPoint(pt, 4, PointType.DEBUG);
            result.push(pt);
            i = closest.index;
        }
        if (i < segs.length - 1) {
            result.push(segs[i].end);
        }
    }
    return result;
}

function range(start: number, end: number) {
    let result = [];
    for (let i = start; i <= end; ++i) {
        result.push(i);
    }
    return result;
}

function validIntersection(intersection: {u: number, v: number}) {
    const eps = 1e-9;
    return intersection != null && intersection.u >= -eps && intersection.u <= 1 + eps && intersection.v >= -eps && intersection.v <= 1 + eps &&
        ((intersection.u > 0 && intersection.u < 1) || (intersection.v > 0 && intersection.v < 1));
}

function getIntersectionPoint(intersection: {u: number, v: number}, segment1: Segment) {
    return vec_plus(segment1.start, vec_mult(vec(segment1.start, segment1.end), intersection.u));
}

function ensureLeftMargin(pts: Point[]) {
    const closestLeft = Math.min(...pts.map(p => p.x));
    let offset = 0;
    if (closestLeft < horizontalBufferPx) {
        offset = horizontalBufferPx - closestLeft;
        //Do this instead of .map(...) + reassigning, because that screws up the selected marker
        shiftPoints(pts, {x: offset, y: 0});

        // console.log("Offset: ", offset, "content left: ", scrollbox.content.left);
        // console.log("Content left: ", scrollbox.content.left);
    }

    return offset;
}

function applyDiffs(pts: Point[], diffs: Point[]) {
    return pts.map((p, i) => ({ x: p.x + diffs[i].x, y: p.y + diffs[i].y }));
}

function getBaseControlPoints(pointset: Pointset): Point[] {
    if (pointset.points.length <= 1) { return []; }
    const points = pointset.points, tangents = monotoneTangents(points);
    return getControlPointsFromTangents(points, tangents)
}

function getEffectiveControlPoints(pointset: Pointset): Point[] {
    return applyDiffs(getBaseControlPoints(pointset), pointset.controlPointDiffs);
}

function getControlPointsForPoint(ps: Pointset, i: number, controlPoints: Point[]) {
    const cp1 = i > 0 ? controlPoints[2*i-1] : null;
    const cp2 = i < ps.points.length - 1 ? controlPoints[2*i] : null;
    return [cp1, cp2];
}

function addControlPointDiffsForPoint(ps: Pointset, i: number, cp1?: Point, cp2?: Point) {
    const defVal = { x: 0, y: 0 }, diffs = ps.controlPointDiffs, len = ps.points.length;
    if (len <= 1) {
        return;
    }

    if (i > 0) { diffs.splice(2*i - 1, 0, cp1 || defVal); }
    if (i < len - 1) { diffs.splice(2*i, 0, cp2 || defVal); }

    if (i == 0) {
        const toAdd = (len > 2 ? ptMinus(diffs[1]) : defVal);
        diffs.splice(2*i + 1, 0, toAdd);
    } else if (i == len - 1) {
        const toAdd = (len > 2 ? ptMinus(diffs[diffs.length - 2]) : defVal);
        diffs.splice(2*i - 2, 0, toAdd);
    }
}

function repaintPointset(ps: Pointset) {
    const points = ps.points;
    if (points.length > 1) {
        lines(points);
    }

    if (isDisplayingPoints()) {
        for (let point of points) {
            drawPoint(point, pointRadius, isSelected(point) ? PointType.SELECTED : PointType.REGULAR);
        }
    }
}

function ptMinus(pt1: Point, pt2?: Point): Point {
    if (pt2 == null) { return {x: -pt1.x, y: -pt1.y }; }
    return {x: pt1.x - pt2.x, y: pt1.y - pt2.y };
}

function ptPlus(pt1: Point, pt2: Point): Point {
    return {x: pt1.x + pt2.x, y: pt1.y + pt2.y };
}

function addNewAtIndex(pointset: Pointset, coords: Point, i: number): Point {
    const newPt = pt(coords.x, coords.y);
    pointset.points.splice(i, 0, newPt);
    addControlPointDiffsForPoint(pointset, i);
    return newPt;
}

function last<T>(arr: T[]): T {
    if (arr.length == 0) {
        return null;
    }
    return arr[arr.length - 1];
}

function drag(point: Point, coords: Point) {
    point.y = coords.y;
    point.x = coords.x;
}

function dragCp(i: number, i2: number, cps: Point[], point: Point, coords: Point) {
    const {pointset: ps} = findPointsetAndIndex(point);
    const newCp = coords;
    ps.controlPointDiffs[i] = ptPlus(ps.controlPointDiffs[i], ptMinus(newCp, cps[i]));
    if (i2 != null) {
        const newCp2 = ptPlus(point, ptMinus(point, newCp));
        ps.controlPointDiffs[i2] = ptPlus(ps.controlPointDiffs[i2], ptMinus(newCp2, cps[i2]));
    }
}

function deleteAtIndex(pointset: Pointset, i: number) {
    pointset.points.splice(i, 1);

    //Also delete control point(s)
    const diffs = pointset.controlPointDiffs;
    if (i < pointset.points.length - 1) { diffs.splice(2*i, 1); }
    if (i > 0) { diffs.splice(2*i-1, 1); }
}

function deleteAtIndices(pointset: Pointset, indices: number[]) {
    const sortedIndices = [...indices].sort((i1, i2) => i2 - i1);
    for (let i of sortedIndices) {
        deleteAtIndex(pointset, i);
    }
}

function deleteSelected() {
    if (selected.length > 0) {
        const pointInfos = selected.map(pt => {
            let {pointset: ps, index: i} = findPointsetAndIndex(pt);
            return [ps, pt, i]; //also need to point for the un-apply operation
        }).reduce((res, [ps, pt, i]) => {
            let existing = res.get(ps);
            if (existing == null) {
                res.set(ps, existing = []);
            }
            existing.push([pt, i]);
            return res;
        }, new Map());
        //sorting the indices in asc order makes the inverse operation easier
        // (no need to keep track of indices, just adding at the specified ones works fine)
        for (let k of pointInfos.keys()) {
            pointInfos.get(k).sort(([_, i1]: [Point, number], [_1, i2]: [Point, number]) => i1 - i2);
        }
        const cmd = {
            apply: () => {
                for (let ps of pointInfos.keys()) {
                    deleteAtIndices(ps, pointInfos.get(ps).map(([_, i]: [Point, number]) => i));
                }
                selected = [];
            },
            unapply: () => {
                for (let ps of pointInfos.keys()) {
                    for (let [pt, i] of pointInfos.get(ps)) {
                        addNewAtIndex(ps, pt, i);
                    }
                }
            }
        }
        doCommand(cmd);
    }
}

function undo() {
    if (undoStack.length > 0) {
        let last = undoStack.pop();
        last.unapply();
        repaint();

        saveCurrentState();
        redoStack.push(last);
    }
}

function redo() {
    if (redoStack.length > 0) {
        let last = redoStack.pop();
        last.apply();
        repaint();

        saveCurrentState();
        undoStack.push(last);
    }
}

function doCommand(cmd: Command) {
    cmd.apply();

    undoStack.push(cmd);
    //can only redo immediately after undo, otherwise the commands in there can be invalid
    redoStack = [];

    saveCurrentState();
    repaint();
}


function registerKey(key: string, callback: (e: KeyboardEvent) => void, repeatable?: boolean) {
    keyCallbacks[key] = { callback: callback };
    if (repeatable) {
        keyCallbacks[key].repeatable = true;
    }
}

function registerKeyUp(key: string, callback: (e: KeyboardEvent) => void) {
    keyCallbacks[key] = keyCallbacks[key] || {};
    keyCallbacks[key].upCallback = callback;
}

function onKeyDown(e: KeyboardEvent) {
    let state = keyState[e.key];
    if (state == null) {
        keyState[e.key] = state = { lastTriggered: 0 };
    }

    if (keyCallbacks[e.key]) {
        let {callback, repeatable} = keyCallbacks[e.key];

        if (repeatable && performance.now() - state.lastTriggered > repeatThreshold) {
            state.lastTriggered = performance.now();
            callback(e);
        }
    }
}

function onKeyUp(e: KeyboardEvent) {
    const callbacks = keyCallbacks[e.key];
    if (callbacks) {
        //If it's a repeatable action, it would've been triggered on key down, no need again
        if (callbacks.callback && !callbacks.repeatable) {
            callbacks.callback(e);
        }
        if (callbacks.upCallback) {
            callbacks.upCallback(e);
        }
    }
}

function stringify(obj: Point | Point[], precision?: number) {
    precision = precision || 2;
    let ptToStr = (p: Point) => `(${p.x.toFixed(precision)}, ${p.y.toFixed(precision)})`;
    if (obj instanceof Array) {
        return "[" + obj.map(ptToStr).join(", ") + "]";
    }
    return ptToStr(obj);
}

function appendPointDescriptions(points: Point[], controlPoints: Point[]) {
    $("#points").append(stringify(points) + " <br>");
    $("#control-points").append(stringify(controlPoints) + " <br>");
}

function appendNormalizedDescriptions(points: Point[], controlPoints: Point[]) {
    $("#normalized-points").append(stringify(points, 4) + " <br>");
    $("#normalized-control-points").append(stringify(controlPoints, 4) + " <br>");
}

function resetPointDescriptions() {
    $("#points").text("");
    $("#control-points").text("");
}

function resetNormalizedPointDescriptions() {
    $("#normalized-points").text("");
    $("#normalized-control-points").text("");
}

function setZoom(newZoom: number) {
    zoomLevel = newZoom;

    graphics.scale.set(zoomLevel, zoomLevel);
    scrollbox.content.clamp({ direction: 'all', underflow: 'top-left'});
    scrollbox.update();

    //TODO: Seems fishy..
    const z1 = Math.min(zoomLevel, 1.0);
    const b = graphics.getBounds();
    const w = (b.width - b.x);
    const h = (b.height - b.y);
    //console.log("Setting hit area to: ", w/z1, h/z1);
    //console.log("Graphics bounds: ", graphics.getBounds());
    graphics.hitArea = new PIXI.Rectangle(0, 0, w / z1, h / z1)

    $("#zoom-level").text("" + zoomLevel);
}

function zoomIn(e: KeyboardEvent) {
    setZoom(zoomLevel * zoomFactor);
}

function zoomOut(e: KeyboardEvent) {
    setZoom(zoomLevel / zoomFactor);
}

function registerArrowMovement() {
    const moveAmount = 1;
    //make sure we copy everything
    const saveSelected = () => {
        if (keyboardDragged.length == 0) {
            keyboardDragged = selected.map(pt => ({ ...pt }));
        }
    }
    const registerMoveCmd = () => {
        const psi = selected.map(findPointsetAndIndex),
            fromCoords = keyboardDragged.map(x => ({ ...x })),
            toCoords = selected.map(x => ({ ...x }));
        keyboardDragged = [];

        const command = {
            apply: () => {
                for(let i = 0; i < psi.length; ++i) {
                    const {pointset: ps, index: idx} = psi[i], point = ps.points[idx], to = toCoords[i];
                    drag(point, to);
                }
            },
            unapply: () => {
                for(let i = 0; i < psi.length; ++i) {
                    const {pointset: ps, index: idx} = psi[i], point = ps.points[idx], from = fromCoords[i];
                    drag(point, from);
                }
            }
        };
        doCommand(command);
    }

    let keyData = [{key: "ArrowLeft", offset: {x: -moveAmount}},
        {key: "ArrowRight", offset: {x: moveAmount}},
        {key: "ArrowUp", offset: {y: -moveAmount}},
        {key: "ArrowDown", offset: {y: moveAmount}}];

    for(let keyInfo of keyData) {
        registerKey(keyInfo.key, e => {
            e.preventDefault();
            saveSelected();
            shiftPoints(selected, keyInfo.offset);
            repaint();
        }, true);
        registerKeyUp(keyInfo.key, e => registerMoveCmd());
    }
}


function saveCurrentState() {
    window.localStorage.setItem("recent", JSON.stringify(pointsets));
    window.localStorage.setItem("itemDate", new Date().toJSON());
}

function loadState(items: Pointset[]) {
    pointsets = items;
    //don't care about preserving selected item and undo/redo stack
    //mainly because it's technically difficult
    //- selected relies on equality of references, which would not be true when (de-)serializing
    //- undo/redo stack are code and not data
    selected = [];
    undoStack = redoStack = [];
}

function removeEmpty(pointsets: Pointset[]) {
    return pointsets.filter(ps => ps.points.length > 0);
}

function loadStoredStateIfNotExpired() {
    const dateStr = window.localStorage.getItem("itemDate");
    if (dateStr != null) {
        const savedDate = new Date(dateStr);
        if (Date.now() - savedDate.getTime() <= 376 * 60 * 60 * 1000) { //48 hrs
            console.log("Loading existing..");
            const items = removeEmpty(JSON.parse(window.localStorage.getItem("recent")));
            loadState(items);
        }
    } else {
        console.log("No saved state to load");
    }
}

function clear() {
    pointsets = selected = [];
    undoStack = redoStack = [];
}


function clearSavedState() {
    window.localStorage.clear();
}

function resetControlPoints(points: Point[]) {
    for (let pt of points) {
        const {pointset: ps, index: i} = findPointsetAndIndex(pt);
        //TODO: These (i > 0), (i < len - 1) constructs are repeated throughout
        if (i > 0) { ps.controlPointDiffs[2*i - 1] = {x: 0, y: 0}; }
        if (i < ps.points.length - 1) { ps.controlPointDiffs[2*i] = {x: 0, y: 0}; }
    }
}
