import {Arc, Circle, Line, LineSegment, toRad} from "./geometry.js"


/* Basic structure
Wrap two libRuler functions: RulerSegment.addProperties and RulerSegment.modifyDistanceResult.

RulerSegment.addProperties
- Store the starting token, if any.
- Store the edges if we are on a gridless map.

RulerSegment.modifyDistanceResult
- Modify the distance measured by terrain cost.
- Two basic techniques: gridded and gridless.
- Determine incremental cost for the relevant map type
- Consider terrains, templates, tokens (generically called "terrain").
- If consider 3-D setting is enabled:
  - consider starting token elevation
  - if Elevation Ruler enabled, consider 3-D points provided by that ruler.
  - 3-D cost counts terrain only when the measured point/line is within terrain min/max.

Gridded cost
- The libRuler generator allows us to iterate along each grid space for the measured segment.
- At each grid space, request cost information from Enhanced Terrain Layer.
- Enhanced Terrain Layer (mostly) handles elevation at each grid space step.

Ungridded cost
- Determine all intersections between the measured segment and the terrains.
- For each pairing of intersections, get the midway-point cost.
- Proportion cost based on 3-D elevation when necessary.
*/

// log just for testing; feel free to remove any/all log statements.
const MODULE_ID = "terrain-ruler";
//const FORCE_DEBUG = true;
function log(...args) {
  try {
    if(CONFIG.debug.terrainRuler) {
      console.log(MODULE_ID, '|', ...args);
    }
  } catch (e) {}
}

/*
 * Wrap libRuler's RulerSegment.addProperties method.
 * This is called when the measurement first starts, and again for each RulerSegment.
 * Set properties to the RulerSegment or the RulerSegment.ruler that will be needed later.
 * - Set the token elevation if there is one at the start of the ruler measure.
 *   Used by terrainRulerModifyDistanceResult to set the starting elevation when not
 *   already set.
 * - Store the terrain edges for use when measuring RulerSegments. Avoids re-calculating
 *   for every segment.
 */
export function terrainRulerAddProperties(wrapped, ...args) {
  if(!this.ruler.isTerrainRuler) return wrapped(...args);

  if(this.segment_num === 0) {
    const t = this.ruler._getMovementToken();
    const e = t ? getProperty(t, "data.elevation") : undefined;
    this.ruler.setFlag("terrain-ruler", "starting_token", { id: t?.id, elevation: e });

    // If gridless, we will need the terrain edges.
    // Ruler segments are re-created on a new measurement, so it will hopefully be okay
    // to locate the terrain edges once now rather than for every segment.
    // While tokens, templates, or terrains could all
    // move during measurement, it is arguably reasonable to make the user re-do the
    // measure at that point. I *think* that re-starting a measure should reflect recent
    // changes to the map... testing will tell

    // Each RulerSegment has a link to the Ruler.
    // You can add a flag to Ruler or to RulerSegment.
    // If the property will not change over the segments, better to add to Ruler.
    // These are lighter-weight flags than the Foundry default.

    if(canvas.grid.type === CONST.GRID_TYPES.GRIDLESS) {
      this.ruler.setFlag("terrain-ruler", "terrain_edges", collectTerrainEdges(t?.id));
      log(`addProperties`, collectTerrainEdges(t?.id));
      if (CONFIG.debug.terrainRuler)
		    debugEdges(this.ruler.getFlag("terrain-ruler", "terrain_edges"));
      }
  }

  return wrapped(...args);
}


 /*
  * Wrap libRuler's RulerSegment.modifyDistanceResult method to account for terrain.
  * This will be called when measuring a specific RulerSegment.
  *
  * Goal:
  * Determine the incremental cost of the terrain, add it to the measured distance.
  * Gridded: iterate over the grid using the relevant measure method, determining the
  *          cost multiplier at each square.
  * Ungridded: get all the intersections of terrains/templates/tokens for the measured
  *            line segment. Determine the cost multiplier at each sub-segment between
  *            intersections.
  * use-elevation option: If the physical path has a "z" dimension, use it.
  *                       Otherwise, if the token has an elevation, use it.
  *                       In either case, consider min and max elevation of
  *                       terrain/templates/tokens when calculating the cost.
  *
  * @param {Number} measured_distance The distance measured for the physical path.
  *                                   The physical path is two or more points representing
  *                                   the path for the segment. In the default case, the
  *                                   physical path would have two points equal to
  *                                   this.ray.A and this.ray.B for the segment.
  * @param {Object} physical_path  An object that contains {origin, destination}.
  *                                Each has {x, y}. May have other properties.
  *                                In particular, Elevation Ruler adds a "z" dimension.
  * @return {Number} The distance as modified.
  */
export function terrainRulerModifyDistanceResult(wrapped, measured_distance, physical_path) {
  log(`Starting modifyDistance. Distance: ${measured_distance}. Physical path: (${physical_path.origin.x}, ${physical_path.origin.y}, ${physical_path.origin?.z}) ⇿ (${physical_path.destination.x}, ${physical_path.destination.y}, ${physical_path.destination?.z})`);
  if(!this.ruler.isTerrainRuler) {
    log("Terrain ruler inactive; returning.");
    return wrapped(measured_distance, physical_path);
  }
  measured_distance = wrapped(measured_distance, physical_path);
  log(`modifyDistance after wrapping. Distance: ${measured_distance}.`);

  if (CONFIG.debug.terrainRuler) {
		if (!canvas.terrainRulerDebug?._geometry) {
			canvas.terrainRulerDebug = canvas.controls.addChild(new PIXI.Graphics())
		}
		canvas.terrainRulerDebug.clear()
	}

  // adjust elevation to account for starting token in certain cases
  if(game.settings.get("terrain-ruler", "use-elevation")) {
    let starting_token_elevation = this.ruler.getFlag("terrain-ruler", "starting_token").elevation;
    log(`starting token elevation is ${starting_token_elevation}`);
    starting_token_elevation = starting_token_elevation === undefined ? undefined : starting_token_elevation * canvas.scene.data.grid / canvas.scene.data.gridDistance;
    physical_path.origin.z = physical_path.origin?.z === undefined ? starting_token_elevation : physical_path.origin.z;
    physical_path.destination.z = physical_path.destination?.z === undefined ? starting_token_elevation : physical_path.destination.z;
  } else {
    physical_path.origin.z = undefined;
    physical_path.destination.z = undefined;
  }

  // NaN in the "z" property were causing issues, so check and remove at the start.
  if(physical_path.origin.z === NaN) {
    log(`Origin z is NaN`);
    physical_path.origin.z = undefined;
  }

  if(physical_path.destination.z === NaN) {
    log(`Destination z is NaN`);
    physical_path.destination.z = undefined;
  }

  log(`terrain edges`, this.ruler.getFlag("terrain-ruler", "terrain_edges"), this);

  const total_cost = canvas.grid.type === CONST.GRID_TYPES.GRIDLESS ?
                       measureCostGridless(physical_path, this.ruler.getFlag("terrain-ruler", "terrain_edges")) :
                       measureCostGridded(physical_path);
  return measured_distance + total_cost;
}

 /*
  * Measure the terrain cost for a given path, potentially accounting for elevation.
  * This function is only for gridded maps.
  * Basically, it iterates over the grid using the libRuler generator. The generator
  * returns a grid position for each step representing a visited grid point for the ruler.
  *
  * libRuler uses the same generator to shade the grid squares when measuring.
  * Elevation Ruler wraps the generator to include elevation at the grid point.
  *
  * Goal here is to estimate the incremental cost for each grid step.
  * Different movement rules result in slightly different calculations,
  * but can be broken down into:
  * 1. equidistant: A move in any direction costs the same, so diagonals can be ignored.
  * 2. 5105: A move along a diagonal costs a fixed amount, but alternates between more
  *          and less expensive with additional diagonal moves.
  * 3. euclidean: A move along a diagonal is the actual physical distance.
  * For rules that consider the diagonal (5105, euclidean), the cost must be multiplied
  *   by the specific distance measure for diagonals.
  * @param { origin: {x: Number, y: Number},
  *          destination: {x: Number, y: Number}} physical_path Path to be measured
  * @param {Number|undefined| token_elevation 	Elevation of any starting token.
  * @return {Number} terrain cost for the move, not counting the base move cost.
  */
function measureCostGridded(physical_path) {
  log(`Starting measureCostGridded with path (${physical_path.origin.x}, ${physical_path.origin.y}, ${physical_path.origin?.z}) ⇿ (${physical_path.destination.x}, ${physical_path.destination.y}, ${physical_path.destination?.z})`);

	const gridIter = window.libRuler.RulerUtilities.iterateGridUnderLine(physical_path.origin, physical_path.destination);

	let total_cost = 0;
	let num_diagonals = 0;

	// for consistency with what we expect gridIter to return, set prior to [row, col, elevation]
	let prior = canvas.grid.grid.getGridPositionFromPixels(physical_path.origin.x, physical_path.origin.y).concat(physical_path.z);

	const cost_calculation_type = game.system.id === "pf2e" ? "equidistant" :
																!canvas.grid.diagonalRule ? "euclidean" :
																canvas.grid.diagonalRule === "555" ? "equidistant" :
																canvas.grid.diagonalRule === "5105" ? "5105" :
																"euclidean";

	for(const current of gridIter) {
    let [row, col, elevation] = current; // elevation may be undefined.
    const [prior_row, prior_col, prior_elevation] = prior;

    log(`grid [${row}, ${col}] with elevation ${elevation}`);

    if(!game.settings.get("terrain-ruler", "use-elevation")) {
      elevation = undefined;
    } else if(elevation === undefined) {
      elevation = physical_path.origin.z; // either undefined or the token elevation.
    }

    // try not to inadvertently introduce NaN where we expect undefined
    const elevation_g = elevation === undefined ? undefined : Math.round(elevation / canvas.scene.data.grid * canvas.scene.data.gridDistance);

    if (CONFIG.debug.terrainRuler) {
	    const [x, y] = canvas.grid.grid.getPixelsFromGridPosition(row, col);
			debugStep(x, y, 0x008800);
		}

    // Looking to get the incremental cost for a given grid point.
    // If elevation_g is undefined, Enhanced Terrain Layer will ignore elevation.
    // Otherwise, Enhanced Terrain Layer will consider whether the terrain min/max is
    //   within the elevation provided.
		const c = incrementalCost(col, row, { elevation: elevation_g }); // terrain layer flips them for gridded vs. gridless
    log(`incremental cost at [${row}, ${col}] is ${c}`);

		if(cost_calculation_type === "equidistant") {
			total_cost += equidistantCostForGridSpace(c);
		} else {
		  // Elevation changes are usually diagonal, but it is possible for a token/ruler
		  // to move straight up/down.
      const elevation_change = elevation - prior_elevation || 0; // might be NaN or undefined
		  const is_diagonal = prior_row !== row && prior_col !== col ||
		                      (elevation_change && !(prior_row === row && prior_col === col));

      if(!is_diagonal) {
			  total_cost += equidistantCostForGridSpace(c);
			} else {
			  num_diagonals += 1;
			  // diagonal either is a fixed distance by 5105 rule or is euclidean
				if(cost_calculation_type === "5105") {
					total_cost += grid5105CostForGridSpace(c, num_diagonals);
				} else if(cost_calculation_type === "euclidean") {
					total_cost += gridEuclideanCostForGridSpace(c, current, prior)
				} else {
				  console.error("terrain-ruler|cost calculation type not recognized.");
				}
			}
		}
		prior = current;
	}

	return total_cost;
}

 /*
  * Calculate the cost for a grid square assuming that all movements, including diagonal,
  *   count the same.
  * This is simply the size of the grid space (square or hex) times the cost.
  * @param {Number} c 	Cost to use for the space.
  * @return {Number} Cost for the grid space.
  */
function equidistantCostForGridSpace(c) {
  // pf2e: each move adds 5/10/15/etc. for difficult terrain, regardless of direction.
  // dnd5e 5-5-5: same for purposes of cost; each move adds 5/10/15/etc., regardless of direction

  const grid_distance = canvas.grid.grid.options.dimensions.distance;
  log(`equidistant cost ${c} * ${grid_distance}`);
  return c * grid_distance;
}

 /*
  * Calculate the cost for a grid square assuming 5-10-5 rules for diagonals
  * The base cost is always the grid size * the cost (equidistantCost).
  * But certain diagonals count double.
  * @param {Number} c 							Cost to use for the space.
  * @param {Number} num_diagonals		Diagonals moved thus far.
  * @return {Number} Cost for the grid space.
  */
function grid5105CostForGridSpace(c, num_diagonals) {
  // diagonal is a fixed distance
  let mult = 0;
	if(num_diagonals % 2 === 0) {
		// even number: double cost in default, single otherwise
		mult = game.settings.get("terrain-ruler", "15-15-15") ? 1 : 2;
	} else {
	  mult = game.settings.get("terrain-ruler", "15-15-15") ? 2 : 1;
	}
  log(`5-10-5 cost ${equidistantCostForGridSpace(c)} * ${mult}`);

	return equidistantCostForGridSpace(c) * mult;
}

 /*
  * Calculate the cost for a grid square assuming Euclidean measurement.
  * Basically, this is the actual distance traveled through the space times cost.
  *
  * @param {Number} c 														Cost to use for the space.
  * @param {Array[row, col, elevation]} current		Current space from gridIteration. Row and column of the gridspace, plus elevation or undefined.
  * @param {Array[row, col, elevation]} prior		  Prior space from gridIteration. Row and column of the gridspace, plus elevation or undefined.
  * @return {Number} Cost for the grid space.
  */
function gridEuclideanCostForGridSpace(c, current, prior) {
  const [row, col, current_elevation] = current;
  const [prior_row, prior_col, prior_elevation] = prior;

  log(`Prior: [${prior_row}, ${prior_col}, ${prior_elevation}], Current: [${row}, ${col}, ${current_elevation}]`);

  // Euclidean: need the actual distance measured for the step
  const p_step = {};
  const p_prior = {};
  [p_step.x, p_step.y] = canvas.grid.grid.getPixelsFromGridPosition(row, col);
  [p_prior.x, p_prior.y] = canvas.grid.grid.getPixelsFromGridPosition(prior_row, prior_col);

	if(game.settings.get("terrain-ruler", "use-elevation")) {
		p_step.z = current_elevation || 0;
		p_prior.z = prior_elevation || 0;
	}

  // Elevation Ruler will override calculateDistance for 3-D points; otherwise ignored.
  log(`Point Prior: (${p_prior.x}, ${p_prior.y}, ${p_prior.z}), Step: (${p_step.x}, ${p_step.y}, ${p_step.z})`);
  let step_distance = window.libRuler.RulerUtilities.calculateDistance(p_prior, p_step);

  // Question: round here or above just before returning the summed costs?
  step_distance = Math.round(step_distance / canvas.scene.data.grid * canvas.scene.data.gridDistance); // convert pixel distance to grid units


  log(`euclidean cost ${c} * ${step_distance}`);
	return c * step_distance;
}


 /*
  * Measure the cost for movement on terrain on a gridless map.
  * Basic solution is to determine when the path intersects the edge of terrain, and
  *   calculate the portion of the distance within the terrain.
  * Terrain is actually 3-D (has min and max elevation, so basically a cubic shape).
  *   So if the segment is within the 2d terrain polygon, determine if the line will
  *   go above or below the terrain at some point.
  * Templates treated just like terrain, and can be given min/max when using
  *   Enhanced Terrain Layer.
  * If considering tokens as difficult terrain, must locate intersections for any tokens.
  *   Consider a 3-D bounding box to have a bottom equal to the token elevation, and extend
  *   upwards as high as the token is wide or high.
  * @param { origin: {x: Number, y: Number},
  *          destination: {x: Number, y: Number}} physical_path Path to be measured
  * @param {Array} terrainEdges 									Edges–terrain, template, token–to consider
  * @return {Number} terrain cost for the move, not counting the base move cost.
  */
function measureCostGridless(physical_path, terrainEdges) {
  log(`Starting measureCostGridless with ${terrainEdges?.length} edges and path (${physical_path.origin.x}, ${physical_path.origin.y}, ${physical_path.origin?.z}) ⇿ (${physical_path.destination.x}, ${physical_path.destination.y}, ${physical_path.destination?.z})`, terrainEdges);

  // The elevation ratio tells us how to apportion the physical path distance for a template.
  // Imagine the following, where a physical path crosses a terrain looking overhead on
  //   2-D canvas:
  //            ----------
  //           |          |
  // Origin ---a----------b-----> Destination
  //           |          |
  //            ----------
  // The full path distance is Origin --> Destination.
  // startLength2d: Origin --> a
  // endLength2d: b --> Destination
  //
  // Assume elevation goes from 20 at the origin to 0 at destination.
  // The elevation ratio describes the speed at which elevation decreases over
  //   physical path, assuming a linear decrease. (E.g., slope of the elevation.)
  // start.z: elevation at a
  // end.z: elevation at b
  // Once we have points a and b in 3-D, we can calculate cost for a given intersection
  //   pair, using calculateGridless3dTerrainCost or calculateGridlessTerrainCost.

  const path_dist2d = window.libRuler.RulerUtilities.calculateDistance({ x: physical_path.origin.x, y: physical_path.origin.y },
                                                                       { x: physical_path.destination.x, y: physical_path.destination.y });
  const elevation_change = physical_path.destination.z - physical_path.origin.z;
  const elevation_ratio = elevation_change / path_dist2d || 0;
  log(`elevation_ratio = ${elevation_change} / ${path_dist2d} = ${elevation_ratio}`);

  if (CONFIG.debug.terrainRuler) { debugEdges(terrainEdges); }

  const rulerSegment = LineSegment.fromPoints(physical_path.origin, physical_path.destination);
  const intersections = terrainEdges.map(edge => edge.intersection(rulerSegment)).flat().filter(point => point !== null);
  intersections.push(physical_path.origin);
  intersections.push(physical_path.destination);
  if (rulerSegment.isVertical) {
    intersections.sort((a, b) => Math.abs(a.y - physical_path.origin.y) - Math.abs(b.y - physical_path.origin.y));
  } else {
    intersections.sort((a, b) => Math.abs(a.x - physical_path.origin.x) - Math.abs(b.x - physical_path.origin.x));
  }

  if (CONFIG.debug.terrainRuler)
    intersections.forEach(intersection => debugStep(intersection.x, intersection.y));

  const cost = Array.from(iteratePairs(intersections)).reduce((cost, [start, end]) => {
    if (CONFIG.debug.terrainRuler)
      canvas.terrainRulerDebug.lineStyle(2, cost === 1 ? 0x009900 : 0x990000).drawPolygon([start.x, start.y, end.x, end.y]);

    // add elevation
    // start and end must be on the physical path ray, by definition
    // change elevation proportionally based on how far along the (2d) physical path we are.
    // (for lack of a better option)
    const startLength2d = window.libRuler.RulerUtilities.calculateDistance({ x: physical_path.origin.x, y: physical_path.origin.y }, start);
    const endLength2d = window.libRuler.RulerUtilities.calculateDistance({ x: physical_path.origin.x, y: physical_path.origin.y }, end);

    start.z = elevation_ratio ? startLength2d * elevation_ratio : physical_path.origin.z;
    end.z = elevation_ratio ? endLength2d * elevation_ratio : physical_path.destination.z;
    log(`start.z = ${startLength2d} * ${elevation_ratio} = ${start.z}`);
    log(`end.z = ${endLength2d} * ${elevation_ratio} = ${end.z}`);

    // segmentLength may be measured in 3-D.
    let segmentLength = window.libRuler.RulerUtilities.calculateDistance(start, end);
    // adjust segmentLength for the grid scale and size (even gridless maps have Grid Size (pixels) and Grid Scale distance)
    segmentLength = segmentLength / canvas.scene.data.grid * canvas.scene.data.gridDistance;

    // right now, terrain layer appears to be ignoring tokens on gridless.
    // so the cost from above will not account for any tokens at that point.
    // see line 218 https://github.com/ironmonk88/enhanced-terrain-layer/blob/874efba5d8e31569e3b64fa76376de67b0121693/classes/terrainlayer.js
    // https://github.com/ironmonk88/enhanced-terrain-layer/issues/48
    const incremental_cost = game.settings.get("terrain-ruler", "use-elevation") ?
                               calculateGridless3dTerrainCost(start, end, segmentLength) :
                               calculateGridlessTerrainCost(start, end, segmentLength);

    return cost + incremental_cost
  }, 0);

  return cost;
}

 /*
  * For given 2-D start/end points and the provided segment length, determine the correct
  *   multiplier and return the cost for that segment using that multiplier.
  * As elsewhere, this is the incremental cost for the terrain.
  * It is assumed that the terrain is the same between start and end, so that we can
  *   simply test the mid-point to get the cost.
  * @param {{x: Number, y: Number}} start		Starting intersection point for the terrain
  * @param {{x: Number, y: Number}} end		  Ending intersection point for the terrain
  * @param {Number} segmentLength						Length of the segment for which cost should be applied.
  * @return {Number} Cost for the provided segment
  */
function calculateGridlessTerrainCost(start, end, segmentLength) {
  const cost_x = (start.x + end.x) / 2;
  const cost_y = (start.y + end.y) / 2;
  const mult = incrementalCost(cost_x, cost_y);
  log(`Gridless Terrain Cost for (${start.x}, ${start.y}) ⇿ (${end.x}, ${end.y}): ${segmentLength} * ${mult}`);

	return segmentLength * mult;
}

 /*
  * For a given 3-D start/end points and the provided segment length, determine the correct
  *   multiplier and return the cost for that segment using that multiplier.
  * As elsewhere, this is the incremental cost for the terrain.
  * It is assumed that the terrain is the same between start and end, so that we can
  *   simply test the mid-point to get the cost.
  * The min/max of each terrain type (terrain, template, token) is determined, so that
  *   the proportional part of the segment that is within the terrain can be counted.
  *   (The segment might move above or below the terrain.)
  * @param {{x: Number, y: Number, z: Number}} start		Starting intersection point for the terrain
  * @param {{x: Number, y: Number, z: Number}} end		  Ending intersection point for the terrain
  * @param {Number} segmentLength												Length of the segment for which cost should be applied.
  * @return {Number} Cost for the provided segment
  */
function calculateGridless3dTerrainCost(start, end, segmentLength) {
  // tricky part: if considering elevation, need to get the terrains/templates/tokens
	// the segment could exit the terrain at the top or the bottom, in which case only
	// part of the segment would get the cost.
	// worse, if multiple terrains, the cost could be different as we move up/down in 3d.
  const cost_x = (start.x + end.x) / 2;
	const cost_y = (start.y + end.y) / 2;

	const terrains_at_point = canvas.terrain.terrainFromPixels(cost_x, cost_y);
	const templates_at_point = templateFromPixels(cost_x, cost_y);
	const tokens_at_point = tokenFromPixels(cost_x, cost_y);

	const max_elevation = Math.max(start.z, end.z);
	const min_elevation = Math.min(start.z, end.z);

	// reduce will return 0 if nothing in the array.
	const cost3d_terrains = terrains_at_point.reduce((cost, terrain) => {
		const min = terrain.data.min;
		const max = terrain.data.max;
		const mult = Math.max(terrain.data.multiple - 1, 0); // remember, looking for the incremental cost
                log(`Terrain ${terrain.id}: ${min}–${max}, mult ${mult}`);
		return cost + proportionalCost3d(max, min, mult, segmentLength, max_elevation, min_elevation);
	}, 0);

	const cost3d_templates = templates_at_point.reduce((cost, template) => {
		const min = template.getFlag("enhanced-terrain-layer", "min"); // may be undefined
		const max = template.getFlag("enhanced-terrain-layer", "max"); // may be undefined
		const mult = Math.max(0, template.getFlag("enhanced-terrain-layer", "multiple") - 1 || 0); // remember, looking for the incremental cost
                log(`Template ${template.id}: ${min}–${max}, mult ${mult}`);
		return cost + proportionalCost3d(max, min, mult, segmentLength, max_elevation, min_elevation);
	}, 0);

	const cost3d_tokens = tokens_at_point.reduce((cost, token) => {
		const min = token?.data?.elevation || 0;
		const max = min + getTokenHeight(token);
		const mult = game.settings.get("terrain-ruler", "count-tokens") ? 1 : 0; // remember, looking for the incremental cost
                log(`Token ${token.id}: ${min}–${max}, mult ${mult}`);
		return cost + proportionalCost3d(max, min, mult, segmentLength, max_elevation, min_elevation);
	}, 0);

  log(`Gridless 3d Terrain Cost for (${start.x}, ${start.y}, ${start.z}) ⇿ (${end.x}, ${end.y}, ${end.z}): ${cost3d_terrains}[terrain] + ${cost3d_templates}[template] + ${cost3d_tokens}[token]`);

	return cost3d_terrains + cost3d_templates + cost3d_tokens;
}

 /*
  * Obtain a reasonable estimate of token height given limited information.
  * @param {Token Object}	token		Token at issue.
  * @return {Number} Estimated height of the token.
  */
function getTokenHeight(token) {
  // TO-DO: module to allow input of actual token height in a consistent manner

  // pathfinder height: https://www.aonsrd.com/Rules.aspx?ID=133
  // https://gitlab.com/hooking/foundry-vtt---pathfinder-2e/-/blob/master/src/scripts/config.ts
  let height;
	switch(token?.actor?.data?.data?.traits?.size) {
	  case "grg": height = 48; break; // Pf2e: 32–64'
		case "huge": height = 24; break;  // PHB p. 191: 15 x 15 square; Pf2e: 16–32'
		case "lg": height = 12; break;  // PHB p. 191: 10 x 10 square; Pf2e: 8–16'
		case "med": height = 6; break; // PHB p. 17: 4–8'; PHB p. 191: 5 x 5 square; Pf2e: 4–8'
		case "sm": height = 3; break;  // PHB p. 17: 2–4'; PHB p. 191: 5 x 5 square; Pf2e: 2–4'
		case "tiny": height = 1.5; break;  // PHB p. 191: 2.5 x 2.5 square; Pf2e: 1–2'
	}

  height = height || Math.round(Math.max(token.hitArea.height, token.hitArea.width) / canvas.scene.data.grid * canvas.scene.data.gridDistance);

  return height;
}

 /*
  * Helper function to trim a segment into the part within a given elevation
  * @param {Number} max						Maximum terrain height, in grid units.
  * @param {Number} min						Minimum terrain height, in grid units.
  * @param {Number} mult					Cost multiplier.
  * @param {Number} segmentLength	Total length of the segment
  * @param {Number} max_elevation	Maximum "z" point for the segment where it intersects the terrain, in pixel units
  * @param {Number} min_elevation	Minimum "z" point for the segment where it intersects the terrain, in pixel units
  * @return {Number} Proportional cost of the 3d segment.
  */
function proportionalCost3d(max, min, mult, segmentLength, max_elevation, min_elevation) {
  log(`proportional cost for segment length ${segmentLength}, mult ${mult}, elevation ${min_elevation}–${max_elevation} (Min/Max: ${min}–${max})`)
	if(mult === 0) return 0;

  // need to convert max/min to same units as max_elevation / min_elevation
  max = max * canvas.scene.data.grid / canvas.scene.data.gridDistance;
  min = min * canvas.scene.data.grid / canvas.scene.data.gridDistance

  log(`proportional cost: converted min/max to ${min}–${max}`);

	if((max === undefined || max === NaN || max_elevation < max) &&
	   (min === undefined || min === NaN || min_elevation > min)) {
	  // segment entirely within the terrain if terrain has elevation
          return mult * segmentLength;
	}

	if(min_elevation > max) return 0; // segment is entirely above the terrain
	if(max_elevation < min) return 0; // segment is entirely below the terrain

  // the line is nearly parallel to the 2-d map, and we already checked that it was within the min/max
  // so the whole line counts
	if(window.libRuler.RulerUtilities.almostEqual(max_elevation, min_elevation)) return segmentLength * mult;

  // line is not parallel to the 2-d map, so it may exit the top or bottom of the object being tested.
	// Proportion the segment based on what part(s) are cut off
	// if the segment runs over the top, find the top part of the segment and trim. Same for bottom.
	const total_elevation_shift = Math.abs(max_elevation - min_elevation);

	// elevation is what proportion of the elevation change?
	const top_trim_elevation = Math.max(max_elevation - max, 0);
	const top_trim_proportion = top_trim_elevation / total_elevation_shift
	const bottom_trim_elevation = Math.max(min - min_elevation, 0);
	const bottom_trim_proportion = bottom_trim_elevation / total_elevation_shift;

	const remainder_dist = segmentLength -
												 segmentLength * top_trim_proportion -
												 segmentLength * bottom_trim_proportion;

	return remainder_dist * mult;
}

 /*
  * Get templates that contain a pixel position.
  * @param {Number} x		Pixel position along x axis
  * @param {Number} y		Pixel position along y axis
  * @return {Array} Templates that contain the pixel position.
  */
function templateFromPixels(x, y) {
	const hx = (x + (canvas.grid.w / 2));
	const hy = (y + (canvas.grid.h / 2));

	let templates = canvas.templates.placeables.filter(t => {
			const testX = hx - t.data.x;
			const testY = hy - t.data.y;
			return t.shape.contains(testX, testY);
	});

	return templates;
}

 /*
  * Get tokens that contain a pixel position.
  * Assumption is that a token hitArea is the relevant width/height for considering as
  *   difficult terrain.
  * @param {Number} x		Pixel position along x axis
  * @param {Number} y		Pixel position along y axis
  * @return {Array} Tokens that contain the pixel position.
  */
function tokenFromPixels(x, y) {
	let tokens = canvas.tokens.placeables.filter(t => {
    const t_shape = new PIXI.Rectangle(t.x, t.y, t.hitArea.width, t.hitArea.height)
		return t_shape.contains(x, y);
	});

	return tokens;
}

 /*
  * Helper function to calculate the incremental cost from the cost function.
  * Ensures incremental cost will be minimum 0.
  * TO-DO: Should the minimum cost be -1 to represent terrain with cost 0?
  * @param {Number} x		    Pixel position along x axis
  * @param {Number} y		    Pixel position along y axis
  * @param {Object} options	Options passed to cost function.
  */
function incrementalCost(x, y, options={}) {
  const cost = getCostEnhancedTerrainlayer(x, y, options);
  //log(`cost at ${x}, ${y} is ${cost}`, options);
  // TO-DO: Should the minimum cost be -1 to represent terrain with cost 0?

  return Math.max(0, cost - 1);
}

 /*
  * Terrain cost function.
  * @param {Number} x		    Pixel position along x axis
  * @param {Number} y		    Pixel position along y axis
  * @param {Object} options	Options passed to cost function.
  */
export function getCostEnhancedTerrainlayer(x, y, options={}) {
	return canvas.terrain.cost({x: x, y: y}, options);
}


// Collects the edges of all sources of terrain in one array
function collectTerrainEdges(token_id_to_exclude) {
	const terrainEdges = canvas.terrain.placeables.reduce((edges, terrain) => edges.concat(getEdgesFromPolygon(terrain)), []);
	const tokenEdges = canvas.tokens.placeables.reduce((edges, token) => {
	  if(token.id === token_id_to_exclude) return edges;
	  return edges.concat(getEdgesFromToken(token));
	}, []);

	const templateEdges = canvas.templates.placeables.reduce((edges, template) => {
		const shape = template.shape;
		if (template.data.t === "cone") {
			const radius = template.data.distance * canvas.dimensions.size / canvas.dimensions.distance;
			const direction = toRad(template.data.direction + 180);
			const angle = toRad(template.data.angle);
			const startDirection = direction - angle / 2;
			const endDirection = direction + angle / 2;
			edges = edges.concat([
				new Arc({x: template.data.x, y: template.data.y}, radius, direction, angle),
				LineSegment.fromPoints({x: template.data.x, y: template.data.y}, {x: template.data.x - Math.cos(startDirection) * radius, y: template.data.y - Math.sin(startDirection) * radius}),
				LineSegment.fromPoints({x: template.data.x, y: template.data.y}, {x: template.data.x - Math.cos(endDirection) * radius, y: template.data.y - Math.sin(endDirection) * radius}),
			]);
		}
		else if (shape instanceof PIXI.Polygon) {
			edges = edges.concat(getEdgesFromPolygon(template));
		}
		else if (shape instanceof PIXI.Circle) {
			edges.push(new Circle({x: template.x + shape.x, y: template.y + shape.y}, shape.radius));
		}
		else if (shape instanceof NormalizedRectangle) {
			const points = [
				{x: template.x + shape.x, y: template.y + shape.y},
				{x: template.x + shape.x + shape.width, y: template.y + shape.y},
				{x: template.x + shape.x + shape.width, y: template.y + shape.y + shape.height},
				{x: template.x + shape.x, y: template.y + shape.y + shape.height},
			];
			edges = edges.concat([
				LineSegment.fromPoints(points[0], points[1]),
				LineSegment.fromPoints(points[1], points[2]),
				LineSegment.fromPoints(points[2], points[3]),
				LineSegment.fromPoints(points[3], points[0]),
			]);
		}
		else {
			console.warn("Terrain Ruler | Unkown measurement template shape ignored", shape);
		}
		return edges;
	}, []);
	return terrainEdges.concat(templateEdges);
}

function getEdgesFromPolygon(poly) {
	const points = poly.shape.points;
	const edges = [];
	for (let i = 0;i * 2 < poly.shape.points.length - 2;i++) {
		edges.push(LineSegment.fromPoints({x: poly.x + points[i * 2], y: poly.y + points[i * 2 + 1]}, {x: poly.x + points[i * 2 + 2], y: poly.y + points[i * 2 + 3]}));
	}
	return edges;
}

function getEdgesFromToken(token) {
  const edges = [];
  // t.x and t.y are upper left corner
  const x = token.x;
  const y = token.y
  const {height, width} = token.hitArea;
  edges.push(LineSegment.fromPoints({ x: x, y: y }, { x: x + width, y: y }));
  edges.push(LineSegment.fromPoints({ x: x + width, y: y }, { x: x + width, y: y + height }));
  edges.push(LineSegment.fromPoints({ x: x + width, y: y + height }, { x: x, y: y + height }));
  edges.push(LineSegment.fromPoints({ x: x, y: y + height }, { x: x, y: y }));
}

function* iteratePairs(arr) {
	for (let i = 0;i < arr.length - 1;i++) {
		yield [arr[i], arr[i + 1]];
	}
}

function debugStep(x, y, color=0x000000, radius=5) {
	if (canvas.grid.type !== CONST.GRID_TYPES.GRIDLESS) {
		x = (x + 0.5) * canvas.grid.w;
		y = (y + 0.5) * canvas.grid.h;
	}
	canvas.terrainRulerDebug.lineStyle(4, color).drawCircle(x, y, radius);
}

function debugEdges(edges) {
	for (const edge of edges) {
		const painter = canvas.terrainRulerDebug;
		painter.lineStyle(2, 0x000099)
		if (edge instanceof Arc) {
			painter.arc(edge.center.x, edge.center.y, edge.radius, edge.direction - edge.angle / 2 + Math.PI, edge.direction + edge.angle / 2 + Math.PI);
		}
		else if (edge instanceof Circle) {
			painter.drawCircle(edge.center.x, edge.center.y, edge.radius);
		}
		else {
			painter.drawPolygon([edge.p1.x, edge.p1.y, edge.p2.x, edge.p2.y]);
		}
	}
}
