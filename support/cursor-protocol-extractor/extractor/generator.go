// generator.go computes cross-package dependencies and prepares a complete declaration set per protocol package.
package main

import (
	"fmt"
	"os"
)

// generateProtos aggregates declarations by protocol package and generates the files.
func generateProtos(messages []Message, enums []Enum, services []Service, resolver *TypeResolver, outputDir string) {
	os.MkdirAll(outputDir, 0755)

	// Aggregate declarations by protocol package.
	packages := make(map[string]struct {
		messages []Message
		enums    []Enum
		services []Service
	})

	for _, msg := range messages {
		pkg := packages[msg.Package]
		pkg.messages = append(pkg.messages, msg)
		packages[msg.Package] = pkg
	}

	for _, enum := range enums {
		pkg := packages[enum.Package]
		pkg.enums = append(pkg.enums, enum)
		packages[enum.Package] = pkg
	}

	for _, svc := range services {
		pkg := packages[svc.Package]
		pkg.services = append(pkg.services, svc)
		packages[svc.Package] = pkg
	}

	// Build the global type index used for cross-package copying.
	allMessages := make(map[string]*Message)
	allEnums := make(map[string]*Enum)

	for pkgName, pkg := range packages {
		if isGooglePkg(pkgName) {
			continue
		}
		for i := range pkg.messages {
			msg := &pkg.messages[i]
			allMessages[msg.TypeName] = msg
		}
		for i := range pkg.enums {
			enum := &pkg.enums[i]
			allEnums[enum.TypeName] = enum
		}
	}

	// Reset the copied-type index before each generation round.
	copiedTypes = make(map[string]map[string]string)

	for pkgName, pkg := range packages {
		// Google standard packages use the official proto files directly.
		if isGooglePkg(pkgName) {
			fmt.Printf("Skipped: %s (using official proto files)\n", pkgName)
			continue
		}

		// Copy external types referenced by the current package locally.
		augmentedPkg := copyAllExternalTypes(pkgName, pkg, resolver, allMessages, allEnums)
		generateProtoFile(pkgName, augmentedPkg.messages, augmentedPkg.enums, pkg.services, resolver, outputDir)
	}
}

// copyAllExternalTypes recursively copies every external type the current package references.
func copyAllExternalTypes(pkgName string, pkg struct {
	messages []Message
	enums    []Enum
	services []Service
}, resolver *TypeResolver, allMessages map[string]*Message, allEnums map[string]*Enum) struct {
	messages []Message
	enums    []Enum
	services []Service
} {
	if copiedTypes[pkgName] == nil {
		copiedTypes[pkgName] = make(map[string]string)
	}

	// Build the set of types already in the current package and register local names for field resolution.
	localTypes := make(map[string]bool)
	for _, msg := range pkg.messages {
		localTypes[msg.ShortName] = true
		// An empty source name means the type already lives in the current package.
		if copiedTypes[pkgName][msg.ShortName] == "" {
			copiedTypes[pkgName][msg.ShortName] = "local:" + msg.TypeName
		}
	}
	for _, enum := range pkg.enums {
		localTypes[enum.ShortName] = true
		if copiedTypes[pkgName][enum.ShortName] == "" {
			copiedTypes[pkgName][enum.ShortName] = "local:" + enum.TypeName
		}
	}

	// The result keeps the current package's original declarations first.
	result := struct {
		messages []Message
		enums    []Enum
		services []Service
	}{
		messages: append([]Message{}, pkg.messages...),
		enums:    append([]Enum{}, pkg.enums...),
		services: pkg.services,
	}

	totalCopied := 0

	// Keep iterating until no new external dependencies are found.
	for round := 1; ; round++ {
		// Collect external type references in the current messages.
		neededTypes := make(map[string]bool)

		for _, msg := range result.messages {
			preferredPkg, _ := parseTypeName(msg.TypeName)
			for _, f := range msg.Fields {
				collectFieldRefsSimple(f, pkgName, preferredPkg, msg.Pos, msg.ModuleStart, resolver, neededTypes, localTypes)
			}
		}
		for _, svc := range result.services {
			for _, m := range svc.Methods {
				collectMethodRefsSimple(m.InputType, pkgName, svc.Pos, svc.ModuleStart, resolver, neededTypes, localTypes)
				collectMethodRefsSimple(m.OutputType, pkgName, svc.Pos, svc.ModuleStart, resolver, neededTypes, localTypes)
			}
		}

		// Copy the dependency types added this round.
		copiedThisRound := 0
		for typeName := range neededTypes {
			refPkg, shortName := parseTypeName(typeName)
			if refPkg == pkgName || isGooglePkg(refPkg) {
				continue
			}

			// No need to copy again when it already exists locally.
			if localTypes[shortName] {
				continue
			}

			// Copy the message declaration.
			if msg, ok := allMessages[typeName]; ok {
				msgCopy := *msg
				msgCopy.Package = pkgName
				// Keep the original full type name for generating the origin comment.
				result.messages = append(result.messages, msgCopy)
				copiedTypes[pkgName][shortName] = typeName // keep the original full type name.
				localTypes[shortName] = true
				copiedThisRound++
				fmt.Printf("  [%s] round %d copy: %s\n", pkgName, round, typeName)
			} else if enum, ok := allEnums[typeName]; ok {
				// Copy the enum declaration.
				enumCopy := *enum
				enumCopy.Package = pkgName
				result.enums = append(result.enums, enumCopy)
				copiedTypes[pkgName][shortName] = typeName
				localTypes[shortName] = true
				copiedThisRound++
				fmt.Printf("  [%s] round %d copy enum: %s\n", pkgName, round, typeName)
			} else {
				// Register the local reference even when no declaration was found, tolerating types that exist in the bundle but were missed by extraction.
				copiedTypes[pkgName][shortName] = typeName
				localTypes[shortName] = true
				fmt.Printf("  [%s] round %d warning: type %s not found, marked as local reference\n", pkgName, round, typeName)
			}
		}

		totalCopied += copiedThisRound

		if copiedThisRound == 0 {
			break // Stop when no new dependencies were added.
		}

		if round > 20 {
			fmt.Printf("  [%s] warning: copy rounds exceeded 20, possible problem\n", pkgName)
			break
		}
	}

	if totalCopied > 0 {
		fmt.Printf("  [%s] copied %d external types total\n", pkgName, totalCopied)
	}

	return result
}

// collectFieldRefsSimple collects the external types a single field references directly.
func collectFieldRefsSimple(f Field, currentPkg string, preferredPkg string, contextPos int, contextModuleStart int, resolver *TypeResolver,
	neededTypes map[string]bool, localTypes map[string]bool) {

	type refWithKind struct {
		ref  string
		kind string
	}

	var refs []refWithKind
	if f.Kind == "message" || f.Kind == "enum" {
		if v, ok := f.T.(string); ok {
			refs = append(refs, refWithKind{ref: v, kind: f.Kind})
		}
	}
	if f.Kind == "map" && (f.MapValueKind == "message" || f.MapValueKind == "enum") {
		if v, ok := f.MapValueT.(string); ok {
			refs = append(refs, refWithKind{ref: v, kind: f.MapValueKind})
		}
	}

	for _, item := range refs {
		typeName, ok := resolver.ResolveTypeName(item.ref, contextPos, contextModuleStart, preferredPkg, item.kind)
		if !ok {
			continue
		}

		refPkg, shortName := parseTypeName(typeName)
		if refPkg == "" || refPkg == currentPkg || isGooglePkg(refPkg) {
			continue
		}

		// Types already in the current package need no collection.
		if localTypes[shortName] {
			continue
		}

		neededTypes[typeName] = true
	}
}

// collectMethodRefsSimple collects the external types a service method's input or output references.
func collectMethodRefsSimple(ref string, currentPkg string, contextPos int, contextModuleStart int, resolver *TypeResolver,
	neededTypes map[string]bool, localTypes map[string]bool) {

	typeName, ok := resolver.ResolveTypeName(ref, contextPos, contextModuleStart, currentPkg, "message")
	if !ok {
		return
	}

	refPkg, shortName := parseTypeName(typeName)
	if refPkg == "" || refPkg == currentPkg || isGooglePkg(refPkg) {
		return
	}

	if localTypes[shortName] {
		return
	}

	neededTypes[typeName] = true
}

// copiedTypes records copied types' original fully qualified names by target package and short name.
var copiedTypes = make(map[string]map[string]string)

// TypeNode is a node in the type tree of nested messages and enums.
type TypeNode struct {
	// Name is the type name at the current nesting level.
	Name string
	// Message holds the node's message declaration.
	Message *Message
	// Enum holds the node's enum declaration.
	Enum *Enum
	// Children holds the next level of nested types.
	Children map[string]*TypeNode
}

// collectImports collects only Google standard dependencies; other types are copied locally.
func collectImports(currentPkg string, messages []Message, services []Service, resolver *TypeResolver) map[string]bool {
	imports := make(map[string]bool)

	addImport := func(ref string, contextPos int, contextModuleStart int, expectedKind string) {
		typeName, ok := resolver.ResolveTypeName(ref, contextPos, contextModuleStart, currentPkg, expectedKind)
		if !ok {
			return
		}

		refPkg, shortName := parseTypeName(typeName)
		// Import only Google standard types.
		if refPkg == "google.protobuf" {
			var importFile string
			switch shortName {
			case "Struct", "Value", "ListValue", "NullValue":
				importFile = "google/protobuf/struct.proto"
			case "Timestamp":
				importFile = "google/protobuf/timestamp.proto"
			case "Duration":
				importFile = "google/protobuf/duration.proto"
			case "Any":
				importFile = "google/protobuf/any.proto"
			case "Empty":
				importFile = "google/protobuf/empty.proto"
			case "FieldMask":
				importFile = "google/protobuf/field_mask.proto"
			case "BoolValue", "BytesValue", "DoubleValue", "FloatValue",
				"Int32Value", "Int64Value", "StringValue", "UInt32Value", "UInt64Value":
				importFile = "google/protobuf/wrappers.proto"
			default:
				importFile = "google/protobuf/descriptor.proto"
			}
			imports[importFile] = true
		} else if refPkg == "google.rpc" {
			var importFile string
			switch shortName {
			case "Status":
				importFile = "google/rpc/status.proto"
			case "Code":
				importFile = "google/rpc/code.proto"
			default:
				importFile = "google/rpc/status.proto"
			}
			imports[importFile] = true
		}
	}

	for _, msg := range messages {
		for _, f := range msg.Fields {
			if f.Kind == "message" || f.Kind == "enum" {
				if ref, ok := f.T.(string); ok {
					addImport(ref, msg.Pos, msg.ModuleStart, f.Kind)
				}
			}
			// map value types may also reference a standard package.
			if f.Kind == "map" && (f.MapValueKind == "message" || f.MapValueKind == "enum") {
				if ref, ok := f.MapValueT.(string); ok {
					addImport(ref, msg.Pos, msg.ModuleStart, f.MapValueKind)
				}
			}
		}
	}

	for _, svc := range services {
		for _, m := range svc.Methods {
			addImport(m.InputType, svc.Pos, svc.ModuleStart, "message")
			addImport(m.OutputType, svc.Pos, svc.ModuleStart, "message")
		}
	}

	return imports
}
