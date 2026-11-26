# The Sun Bell

A third-person action-adventure for the browser (Vite + three.js + three-mesh-bvh).
A young warden crosses a valley, takes on the temple's puzzles and defeats the Hollow King to make the Sun Bell ring again.

## Run it
- **Windows:** double-click `start-game.bat`. It installs packages the first time and opens the game at http://localhost:5173.
- **Any OS:** `npm install`, then `npm run dev`.

Vite hot-reloads, so the open tab updates whenever a file changes.
Needs Node.js 18+ (https://nodejs.org) and a WebGL 2 browser (Chrome, Edge or Firefox).

## Controls
| | Keyboard / mouse | Controller |
|---|---|---|
| Move / camera | WASD / mouse | LS / RS |
| Sprint | Shift | hold B |
| Roll (i-frames) | Space | tap B |
| Attack (3-hit chain) | LMB (or F) | RB / RT |
| Shield | RMB (or C / Ctrl) | LB / LT |
| Lock on / switch | Q or MMB / Tab or wheel | R3 / d-pad |
| Interact | E | A |
| Drink sunwater | R | X |
| Pause & graphics | Esc | Start |
| FPS counter | F3 | |

## Enemies
- **Zombies** (3D, four of them, from the turnaround sheets in `tools/sheets/zombie1-4.jpg`, with close-up head sheets `zombie*_face.jpg` for the faces): packs shamble through the woods beside the road and join the raids; some run. They reach, lunge and bite. Every hit can cut off a limb: forearms, whole arms, shins, legs or the head. A zombie with one leg hops, with no legs it crawls on its arms, and with no arms it still bites. A head cut off or the last of its health tears it fully apart. Rebuild them after changing a sheet with `python3 -I tools/zombie_build.py`.

## Vehicles from blueprints
The truck and helicopter are built from `tools/sheets/truck.jpg` and `heli.jpg` (side, top, front, rear and bottom views): `python3 -I tools/blueprint.py truck tools/sheets/truck.jpg public/models`.

## Character
Pause menu → **Character**: *Heroine* (the VRM Studio "Base Female" model, `public/models/heroine.glb`) or *Warden* (the procedural hero). The heroine is driven by the warden's animation rig, with her feet re-planted by IK. To swap in another VRM Studio character: export **File → Export MMD model**, then run `python3 tools/pmx2glb.py Base_Female.pmx public/models/heroine.glb`.

## Fortify the camp (level 1)
- **Gather:** swing your sword at trees (2 wood per hit; a tree falls after 3 hits and leaves a stump) and rocks (2 stone per hit). Your backpack holds 20 (each house adds 15).
- **Carry:** bring it to the **stockpile** (log pile by the tent) and press **E**. You can only build with stored supplies.
- **Build:** press **B**. Choose with **1–5** or the mouse wheel, rotate with **R**, place with **LMB**. Building is allowed within 70 m of the camp.

| | Cost | What it does |
|---|---|---|
| Palisade | 6 wood | Wooden wall, 80 HP |
| Stone wall | 8 stone | Strong wall, 200 HP |
| Spike trap | 4 wood, 2 stone | Spikes stab enemies that step on it |
| Cannon | 8 wood, 10 stone | Fires on enemies within 28 m, splash damage |
| House | 30 wood, 15 stone | Backpack +15, hearth +100 HP |
| Bridge | 24 wood, 12 stone | Only at the river crossing; opens the north road |

- **Raids:** the first wave hits after 5 minutes, then every 4 minutes. You can call one early at the **war drum**. Zombies march from the treeline on the **hearth** (the campfire), bashing any wall in their way. Win a raid to earn bonus supplies. If the hearth falls, you lose half your stored supplies. Each wave is bigger.

## The river, the bridge and the truck
- A river cuts the north road just past camp. It's too deep to wade, and the old bridge is in ruins. At the crossing, press **B** then **6** to rebuild it.
- Once the bridge stands, part of each raid comes down the north road and crosses it. **Saboteurs** (some of the zombies) stop on the bridge and hack at it. If it falls, anything on it drops into the river and the north road is cut until you rebuild. Defend it with walls, traps and cannons at the bridgehead.
- **The truck** sits broken in a shed at the south end of the road. Press **E** to repair it (10 wood, 6 stone stored), then **E** to drive: **W/S** drive, **A/D** steer, **Space** brake, **E** to get out. Walk up to the truck to tip your backpack into its bed (holds 60). Drive it next to the stockpile and it unloads by itself. Hit enemies fast enough and you run them over. It can't cross the river without the bridge.

## The temple trials
The doors are sealed by three sun-marks. Each trial on the temple platform rekindles one:
1. **Mirrors** (left front): a sun crystal fires a beam of light. Press **E** at each bronze mirror to turn it, and bounce the beam onto the pedestal.
2. **Bells** (right front): press **E** at the pedestal to hear the hymn, then strike the four bells with your sword in the same order. A wrong note and they play it again.
3. **Embers** (the three corners): strike an ember bowl to light it. Each burns out in 16 seconds, so all three must burn at once. Sprint!

## The Hollow King (final boss)
He kneels before the sealed temple doors like a statue, and rises once all three sun-marks burn. He wields the stolen clapper of the Sun Bell as a mace.
- **Overhead slam:** a long wind-up, then a shockwave where the bell lands. Roll sideways.
- **Sweep:** a wide arc. Roll through it or back away.
- **Bell toll:** a ring of sound spreads out from him. You can't block it; roll through it as it reaches you.
- Below half health his embers flare and he gets faster. Heavy hits stagger him. If you run off, he returns to his place and recovers.
- **Defeat him** and the Sun Bell rings: the hollow fall still, the light warms, and the valley stays open for free roam.

## Helicopter
It's parked on the helipad by the camp. Press **E** to board.
Mouse steers, **WASD** flies, **Space** climbs and **Shift** descends. Hold **LMB** to fire the nose gun, which only works **below 15 m**. Land and press **E** to get out.
Enemies ignore you while you fly. Controller: RT fire, A climb, LB/LT descend, Y exit.

## World & animation
- **Generated textures:** every surface texture is made in code at load time (about 1 s): meadow grass, packed dirt with pebbles, layered rock with lichen, river sand, cut stone blocks with moss, bark, wood planks, cloth and water ripples. Each has a matching normal map. The terrain blends grass, dirt, rock and sand with height-based transitions, and the sand turns darker and glossier at the waterline.
- **Wind:** one wind field drives everything. Gust fronts roll across the valley, so grass leans in visible waves, and trees bend trunk and crown together while their leaves flutter. Autumn leaves blow loose and settle on the ground. The camp banner and the warden's cloak respond to the same gusts, and the wind sound follows them. Grass parts around the warden and the truck. The helicopter's rotor wash flattens grass and shakes trees when you fly low.
- **Water:** it's clear in the shallows and dark in the deep channel, with sun glints and reflections. Foam lines the banks and drifts downstream in streaks, and the surface gets choppier when the wind picks up. Wading splashes and leaves ripples.
- **The warden:** a single skinned body on a full skeleton (spine, neck, head, collarbones, arms, hands with finger and thumb bones, legs, feet, toes).
  - Legs use two-bone IK, so feet plant on the ground, slopes and stairs without sliding. A gait cycle matches the real walking speed, with heel strike and toe-off.
  - Hips twist, sway and bob; the spine counter-rotates and the arms swing opposite the legs, with the elbows bending more when running. He breathes when standing still, his head stays steady and looks where the camera looks, and his fingers grip the sword and the shield straps.
  - The cloak is simulated cloth, pinned to the shoulders and colliding with the body. Footsteps make sound, kick up dust on dirt, and splash in water.

## Graphics
Your GPU picks a preset (Low / Medium / High / Ultra) on first launch. You can change it from the pause menu, or force one with `?quality=high` in the URL.
If the frame rate stays under ~36 fps, Auto drops one preset.

The HDR pipeline (`src/post/`) runs: scene (half-float + depth) → SSAO → ray-marched height fog with sun shadow-map god rays → composite → depth of field → bloom (13-tap down / tent up) → auto-exposure (log-luminance, adapted) → ACES + colour grade (contrast, saturation, lift/gamma/gain, vignette, grain) → FXAA.

| | Low | Medium | High | Ultra |
|---|---|---|---|---|
| Render scale | 0.75 | 0.85 | 1.0 | 1.0 (up to 2× DPR) |
| Shadows | 1024 | 2048 | 2048 | 4096 |
| SSAO | off | 8 | 12 | 16 samples |
| Fog march | 12 @ ¼ | 20 @ ¼ | 32 @ ½ | 48 @ ½ |
| Depth of field | off | off | 24 | 40 samples |
| Grass clumps | 0 | 14k | 26k | 40k |

## Layout
- `src/main.js`: renderer, quality, loop, menus
- `src/post/`: HDR post pipeline and shaders
- `src/world/`: terrain height field, road, trees, camp, temple, BVH collider
- `src/game/`: hero (model, controller, combat), Hollow enemies, Rustcart and Client sprite enemies (`sprites.js` billboards), helicopter, camera rig, effects, HUD/story
- `public/sprites/`: packed sprite atlases (green screen removed)
