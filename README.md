# VVER-1200 plant simulator

An interactive 3D model of a VVER-1200 pressurized water reactor plant that runs in the browser. Drive the control rods, trip coolant pumps, scram the reactor and follow the heat from the core through the steam generators and turbine to the grid. Tap the core to open cross-sections of the core, any fuel assembly and any rod.

Built as a teaching aid for a nuclear engineering capstone at Nazarbayev University.

## Run it

- **Online:** push to `main` and the workflow publishes the site to GitHub Pages at `https://<user>.github.io/<repo>/`. In the repository settings, set *Pages → Source* to *GitHub Actions* once.
- **Locally:** open `index.html` in a browser. three.js loads from cdnjs, so you need a connection the first time.
- **Single file:** `python3 tools/build_single.py` writes `dist/vver1200-sim.html` with everything inlined.
- **Tests:** `node --test tests/physics.test.js` (Node 18 or newer).

## What you can do

- Raise and lower the regulating group (position in % of core height, 100 % = fully withdrawn), change boric acid, trip and restart the four main coolant pumps, scram, reset protection and restart from hot zero power.
- Watch thermal and electrical power, reactivity and its parts, reactor period, neutron power on a log scale, coolant and fuel temperatures, decay heat and turbine speed.
- See flow on every pipe: arrows move with the flow and fade when it stops.
- Open cross-sections: the 163-assembly core (power or fuel loading), a TVS-2006 assembly (312 fuel rods, 18 guide channels, central tube, gadolinia rods), a fuel rod with its live radial temperature profile, and a guide channel with the absorber in or out.

## Model

| Part | Treatment |
|---|---|
| Neutronics | Point kinetics, six delayed groups for U-235 (Keepin 1965), β = 650 pcm, Λ = 20 µs, weak source; implicit integration at 1/600 s |
| Feedback | Doppler −2.2 pcm/K on lumped fuel temperature, moderator −25 pcm/K on average coolant temperature |
| Control | Regulating group 3000 pcm (S-curve), shutdown banks 9000 pcm, boric acid −12 pcm/ppm |
| Heat | Fuel and coolant lumps; steam generators at 7.0 MPa (285.8 °C); decay heat in three groups totalling 6.5 % |
| Secondary | Electrical output 37.5 % of steam generator heat; turbine at 3000 rpm on the grid, coasting down when tripped |
| Protection | Withdrawal blocked below 20 s period, above 104 % power or 330 °C outlet; scram on 112 % power, 335 °C outlet, 10 s period (startup range) or two pumps lost |
| Fuel rod | Steady conduction: UO₂ conductivity from Fink (2000), 6000 W/m²·K gap, Zr-1%Nb cladding at 17 W/m·K, mid-plane with axial factor 1.3 |

Rated conditions: 3200 MWt, 1200 MWe gross, 16.2 MPa, core inlet 298.2 °C and outlet 325 °C.

## Where this departs from standard practice

- This is a teaching model, not a plant simulator. Real VVER analysis couples 3D nodal neutronics to system thermal-hydraulic codes such as KORSAR or RELAP.
- The regulating group is worth 3000 pcm so rods alone can cover the roughly 2000 pcm power defect. Real plants share that job with boric acid.
- Rods move at 1 % of core height per second, about twice real speed.
- The fuel loading pattern, control cluster map and guide channel positions are illustrative, not a real VVER-1200 core design.
- The turbine spin is slowed for viewing. The Cherenkov glow is shown through a cutaway; a real steel vessel hides it.

## Layout

```
index.html               page markup
css/style.css            styles, light and dark themes
js/physics.js            reactor model, core and assembly layouts, rod temperatures (browser and Node)
js/scene.js              three.js plant, pipes, picking and camera
js/xsection.js           cross-section viewer
js/app.js                controls, readouts, charts and main loop
tests/physics.test.js    physics checks run in CI
tools/build_single.py    inlines everything into one HTML file
.github/workflows/       tests, then publishes to GitHub Pages
```

## References

- G. R. Keepin, *Physics of Nuclear Kinetics*, Addison-Wesley, 1965.
- J. K. Fink, "Thermophysical properties of uranium dioxide", *Journal of Nuclear Materials* 279 (2000) 1–18.

Add a licence file of your choice before making the repository public.
