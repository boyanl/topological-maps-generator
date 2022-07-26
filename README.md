![topo-maps-screenshot](https://user-images.githubusercontent.com/28755026/181098983-6c48cb9a-ee37-4864-adaa-80e0e78e9ec7.png)
# Topological maps generator

## Overview
Editor for generating curves that look (somewhat) like a topological maps, with the option of viewing the final result in 3D

# Build & run
You need to have `node` and `npm` (>= 7.0) installed.
After that, run

```npm install```

and then

```npm run start```

Server should be up on port `8081`, just navigate to `http://localhost:8081` and you should see the editor

You can also try it out here - <a href="https://boyanl.github.io/topological-maps-generator/" target="_blank">https://boyanl.github.io/topological-maps-generator/</a> 

## How to use the editor
Add new points by left-clicking on an empty space in the left pane. Select existing points by left-clicking them. You can also multi-select (`Ctrl` + click) and area-select (hold left mouse button and drag selection). You can also drag selected points.

Delete points by selecting one or more of them are press `Delete`

When adding new points, the behaviour depends whether you have a selected point, or not. If there is a selected point, then adding a new point will add it to the polygon, which the current point is a part of.

If there is no point selected, then the new point will be in a separate polygon
