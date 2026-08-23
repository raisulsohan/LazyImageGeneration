// Function: importImageToActiveComp(filePath)
function importImageToActiveComp(filePath) {
    var result = {
        success: false,
        footageName: "",
        addedToTimeline: false,
        compName: "",
        layerIndex: -1,
        dimensions: "",
        error: ""
    };

    if (!filePath || filePath === "") {
        result.error = "File path is empty";
        return objectToJson(result);
    }

    var imageFile = new File(filePath);
    if (!imageFile.exists) {
        result.error = "File does not exist: " + filePath;
        return objectToJson(result);
    }

    var undoGroupActive = false;
    try {
        app.beginUndoGroup("Lazy-Image: Import Image to Timeline");
        undoGroupActive = true;

        var importOptions = new ImportOptions(imageFile);
        importOptions.importAs = ImportAsType.FOOTAGE;
        importOptions.sequence = false;

        var importedFootage = app.project.importFile(importOptions);
        if (!importedFootage) {
            result.error = "Failed to import file into project";
            if (undoGroupActive) app.endUndoGroup();
            return objectToJson(result);
        }

        result.success = true;
        result.footageName = importedFootage.name;
        result.dimensions = importedFootage.width + "x" + importedFootage.height;

        // Determine target composition:
        // 1. Check if activeItem is a CompItem
        var targetComp = null;
        if (app.project.activeItem !== null && app.project.activeItem instanceof CompItem) {
            targetComp = app.project.activeItem;
        } else {
            // 2. If focus is on extension panel, activeItem might be null. Find the most recently active or first comp
            for (var i = 1; i <= app.project.numItems; i++) {
                var item = app.project.item(i);
                if (item instanceof CompItem) {
                    targetComp = item;
                    break;
                }
            }
        }

        if (targetComp !== null) {
            var newLayer = targetComp.layers.add(importedFootage);
            try {
                newLayer.startTime = targetComp.time;
            } catch (tErr) {
                newLayer.startTime = 0;
            }

            result.addedToTimeline = true;
            result.compName = targetComp.name;
            result.layerIndex = newLayer.index;
        } else {
            result.addedToTimeline = false;
            result.error = "No composition found in project to add layer to";
        }
    } catch (e) {
        result.error = e.toString();
    } finally {
        if (undoGroupActive) {
            app.endUndoGroup();
        }
    }

    return objectToJson(result);
}

// Function: getActiveCompInfo()
function getActiveCompInfo() {
    var result = {
        hasComp: false,
        compName: "",
        width: 0,
        height: 0,
        duration: 0,
        frameRate: 0
    };

    var activeItem = app.project.activeItem;
    if (activeItem !== null && activeItem instanceof CompItem) {
        result.hasComp = true;
        result.compName = activeItem.name;
        result.width = activeItem.width;
        result.height = activeItem.height;
        result.duration = activeItem.duration;
        result.frameRate = activeItem.frameRate;
    } else {
        for (var i = 1; i <= app.project.numItems; i++) {
            var item = app.project.item(i);
            if (item instanceof CompItem) {
                result.hasComp = true;
                result.compName = item.name;
                result.width = item.width;
                result.height = item.height;
                result.duration = item.duration;
                result.frameRate = item.frameRate;
                break;
            }
        }
    }

    return objectToJson(result);
}

// Helper to serialize simple objects to JSON string in ExtendScript (ES3)
function objectToJson(obj) {
    if (obj === null) return "null";
    if (typeof obj === "string") return '"' + obj.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    if (typeof obj === "number" || typeof obj === "boolean") return String(obj);
    
    if (obj instanceof Array) {
        var resArr = [];
        for (var i = 0; i < obj.length; i++) resArr.push(objectToJson(obj[i]));
        return "[" + resArr.join(",") + "]";
    }
    
    if (typeof obj === "object") {
        var resObj = [];
        for (var k in obj) {
            if (obj.hasOwnProperty(k)) {
                resObj.push('"' + k + '":' + objectToJson(obj[k]));
            }
        }
        return "{" + resObj.join(",") + "}";
    }
    
    return '""';
}
