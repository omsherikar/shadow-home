# Credits for the 3D house

Every downloaded asset here comes from [Poly Haven](https://polyhaven.com) and is released under
[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) ([Poly Haven's licence page](https://polyhaven.com/license)).
CC0 asks for no attribution; the authors are named anyway, with thanks.

Each model was downloaded as Poly Haven's 1k glTF and shrunk with glTF Transform 4.5.0
(`gltf-transform optimize --compress quantize --texture-compress webp --texture-size <size> --instance false`):
textures resized and re-encoded as WebP (`EXT_texture_webp`), geometry quantized
(`KHR_mesh_quantization`) and lightly simplified, and meshes joined, into one `.glb`. No Draco,
meshopt or KTX2, so the browser loads them without a decoder. The steel shelves are authored at
ten times real size; the layout places them at a scale of 0.1. The stove's control panel carried a
maker's name; it was painted out of its colour, normal and roughness maps (blended across from the
plain panel either side) before shrinking, so the model shows no brand.

## Models (`models/`)

| File | Asset | Authors | Textures | Size |
| --- | --- | --- | --- | --- |
| `sofa_02.glb` | [Sofa 02](https://polyhaven.com/a/sofa_02) | Kirill Sannikov | 1024 px WebP | 194 KB |
| `modern_arm_chair_01.glb` | [Modern Arm Chair 01](https://polyhaven.com/a/modern_arm_chair_01) | Vibrant Nordic | 512 px WebP | 215 KB |
| `modern_coffee_table_01.glb` | [Modern Coffee Table 01](https://polyhaven.com/a/modern_coffee_table_01) | Amin | 512 px WebP | 122 KB |
| `modern_wooden_cabinet.glb` | [Modern Wooden Cabinet](https://polyhaven.com/a/modern_wooden_cabinet) | Patrik Pangerl | 512 px WebP | 715 KB |
| `potted_plant_04.glb` | [Potted Plant 04](https://polyhaven.com/a/potted_plant_04) | James Ray Cock | 512 px WebP | 273 KB |
| `side_table_01.glb` | [Side Table 01](https://polyhaven.com/a/side_table_01) | James Ray Cock | 512 px WebP | 129 KB |
| `electric_stove.glb` | [Electric Stove](https://polyhaven.com/a/electric_stove) | Kuutti Siitonen | 1024 px WebP | 464 KB |
| `round_wooden_table_01.glb` | [Round Wooden Table 01](https://polyhaven.com/a/round_wooden_table_01) | Ulan Cabanilla | 1024 px WebP | 269 KB |
| `painted_wooden_chair_01.glb` | [Painted Wooden Chair 01](https://polyhaven.com/a/painted_wooden_chair_01) | Kuutti Siitonen | 512 px WebP | 90 KB |
| `throw_pillows_01.glb` | [Throw Pillows 01](https://polyhaven.com/a/throw_pillows_01) | Serhii Khromov | 512 px WebP | 265 KB |
| `vintage_wooden_drawer_01.glb` | [Vintage Wooden Drawer 01](https://polyhaven.com/a/vintage_wooden_drawer_01) | James Ray Cock | 512 px WebP | 216 KB |
| `schooldesk_01.glb` | [School Desk 01](https://polyhaven.com/a/SchoolDesk_01) | Ethan Place | 512 px WebP | 121 KB |
| `schoolchair_01.glb` | [School Chair 01](https://polyhaven.com/a/SchoolChair_01) | Ethan Place | 512 px WebP | 141 KB |
| `wooden_display_shelves_01.glb` | [Wooden Display Shelves 01](https://polyhaven.com/a/wooden_display_shelves_01) | James Ray Cock | 512 px WebP | 116 KB |
| `rubber_duck_toy.glb` | [Rubber Duck Toy](https://polyhaven.com/a/rubber_duck_toy) | Plat251 | 512 px WebP | 96 KB |
| `covered_car.glb` | [Covered Car](https://polyhaven.com/a/covered_car) | MP | 1024 px WebP | 489 KB |
| `steel_frame_shelves_01.glb` | [Steel Frame Shelves 01](https://polyhaven.com/a/steel_frame_shelves_01) | James Ray Cock | 1024 px WebP | 227 KB |
| `cardboard_box_01.glb` | [Cardboard Box 01](https://polyhaven.com/a/cardboard_box_01) | Rahul Chaudhary | 512 px WebP | 318 KB |
| `plastic_crate_02.glb` | [Plastic Crate 02](https://polyhaven.com/a/plastic_crate_02) | Fabi_G | 512 px WebP | 180 KB |
| `old_tyre.glb` | [Old Tyre](https://polyhaven.com/a/old_tyre) | MP | 512 px WebP | 151 KB |
| `wooden_ladder.glb` | [Wooden Ladder](https://polyhaven.com/a/wooden_ladder) | Miroslav Turura | 512 px WebP | 223 KB |

## Floor textures (`textures/`)

Colour, normal (OpenGL) and ambient occlusion, roughness and metal maps from the 1k sets,
re-encoded as WebP at 1024 px.

| Files | Asset | Authors | Size |
| --- | --- | --- | --- |
| `wood_floor_diff.webp`, `wood_floor_nor_gl.webp`, `wood_floor_arm.webp` | [Wood Floor](https://polyhaven.com/a/wood_floor) | Dimitrios Savva | 125 KB |
| `floor_tiles_06_diff.webp`, `floor_tiles_06_nor_gl.webp`, `floor_tiles_06_arm.webp` | [Floor Tiles 06](https://polyhaven.com/a/floor_tiles_06) | Rob Tuytel | 78 KB |
| `concrete_floor_worn_001_diff.webp`, `concrete_floor_worn_001_nor_gl.webp`, `concrete_floor_worn_001_arm.webp` | [Concrete Floor Worn 001](https://polyhaven.com/a/concrete_floor_worn_001) | Dimitrios Savva, Rico Cilliers | 111 KB |

## Environment light (`env/`)

The 1k HDR file, unchanged, used only to light the scene; the sky itself is drawn in code.

| File | Asset | Authors | Size |
| --- | --- | --- | --- |
| `belfast_sunset_puresky_1k.hdr` | [Belfast Sunset (Pure Sky)](https://polyhaven.com/a/belfast_sunset_puresky) | Dimitrios Savva, Greg Zaal, Jarod Guest | 1162 KB |

## Built in code

No CC0 model fitted these, so they are drawn from simple shapes in matching materials: the walls,
the kitchen counters, both beds, the rugs, the garage's wall heater, the people, and every smart
device (thermostats, lights, plugs and what they power, locks, sensors, the smoke alarm, the
dishwasher, the coffee maker, the TV, the aquarium and the chest freezer), since devices light up
and change as the plan plays.
