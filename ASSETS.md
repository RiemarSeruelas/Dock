# DockFlow image files

Place custom images at these exact project paths before rebuilding Docker:

| Purpose | Project path | Recommended image |
|---|---|---|
| Login background | `public/images/dockflow-background.jpg` | Wide facility or truck photo, at least 1600×1000 |
| Receiving-lane truck | `public/images/parked-truck.jpg` | Top-view truck, preferably square |
| DockFlow logo | `public/uploads/dockflow-logo.png` | Transparent PNG, at least 128×128 |

The login page darkens the background automatically. Do not add an overlay to the source photo. If the logo file is absent or cannot load, the interface uses the built-in DockFlow route icon without showing a broken image.
