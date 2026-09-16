// renderer.go renders the protocol declaration tree into stable proto text.
package main

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// generateProtoFile renders a single protocol package's declarations and writes the file.
func generateProtoFile(pkgName string, messages []Message, enums []Enum, services []Service, resolver *TypeResolver, outputDir string) {
	// First collect all cross-package standard dependencies.
	imports := collectImports(pkgName, messages, services, resolver)

	var sb strings.Builder

	sb.WriteString(`syntax = "proto3";` + "\n\n")
	sb.WriteString(fmt.Sprintf("package %s;\n\n", pkgName))

	// Write imports in stable order.
	if len(imports) > 0 {
		sortedImports := make([]string, 0, len(imports))
		for imp := range imports {
			sortedImports = append(sortedImports, imp)
		}
		sort.Strings(sortedImports)
		for _, imp := range sortedImports {
			sb.WriteString(fmt.Sprintf("import \"%s\";\n", imp))
		}
		sb.WriteString("\n")
	}

	goPackagePath := strings.ReplaceAll(pkgName, ".", "/")
	goPackageName := strings.ReplaceAll(pkgName, ".", "")
	sb.WriteString(fmt.Sprintf(`option go_package = "github.com/leookun/cursor-byok/cursor-proto/gen/%s;%s";`+"\n\n", goPackagePath, goPackageName))

	// Build the nested type tree.
	root := &TypeNode{Children: make(map[string]*TypeNode)}

	for i := range messages {
		msg := &messages[i]
		path := getNestedPath(msg.ShortName)
		insertMessage(root, path, msg)
	}

	for i := range enums {
		enum := &enums[i]
		path := getNestedPath(enum.ShortName)
		insertEnum(root, path, enum)
	}

	// Write all top-level types.
	writeTypeTree(root, &sb, resolver, 0, pkgName)

	// Write service declarations.
	sort.Slice(services, func(i, j int) bool {
		return services[i].ShortName < services[j].ShortName
	})

	for _, svc := range services {
		// Write the service origin comment.
		sb.WriteString(fmt.Sprintf("// Source: %s (var: %s)\n", svc.TypeName, svc.VarName))
		sb.WriteString(fmt.Sprintf("service %s {\n", svc.ShortName))
		for _, m := range svc.Methods {
			inputType := resolveMethodType(m.InputType, resolver, pkgName, svc.Pos, svc.ModuleStart)
			outputType := resolveMethodType(m.OutputType, resolver, pkgName, svc.Pos, svc.ModuleStart)

			switch m.Kind {
			case "ServerStreaming":
				sb.WriteString(fmt.Sprintf("  rpc %s(%s) returns (stream %s) {}\n", m.Name, inputType, outputType))
			case "ClientStreaming":
				sb.WriteString(fmt.Sprintf("  rpc %s(stream %s) returns (%s) {}\n", m.Name, inputType, outputType))
			case "BiDiStreaming":
				sb.WriteString(fmt.Sprintf("  rpc %s(stream %s) returns (stream %s) {}\n", m.Name, inputType, outputType))
			default: // Default to a unary call.
				sb.WriteString(fmt.Sprintf("  rpc %s(%s) returns (%s) {}\n", m.Name, inputType, outputType))
			}
		}
		sb.WriteString("}\n\n")
	}

	// Each protocol package is written as a single file in the flat output directory.
	fileName := strings.ReplaceAll(pkgName, ".", "_") + ".proto"
	filePath := filepath.Join(outputDir, fileName)

	os.WriteFile(filePath, []byte(sb.String()), 0644)
	fmt.Printf("Generated: %s (%d messages, %d enums, %d services)\n", filePath, len(messages), len(enums), len(services))
}

// resolveMethodType resolves method message types and handles locally copied types.
func resolveMethodType(ref string, resolver *TypeResolver, currentPkg string, contextPos int, contextModuleStart int) string {
	typeName, ok := resolver.ResolveTypeName(ref, contextPos, contextModuleStart, currentPkg, "message")
	if !ok {
		activeDiagnostics.addUnresolvedType("method:" + ref)
		return fallbackTypeToken(ref)
	}

	refPkg, shortName := parseTypeName(typeName)
	if refPkg == currentPkg || refPkg == "" {
		return shortName
	}
	// Check whether the type was copied into the current package from another.
	if copied := copiedTypes[currentPkg]; copied != nil {
		if _, isCopied := copied[shortName]; isCopied {
			return shortName
		}
	}
	return refPkg + "." + shortName
}

// insertMessage inserts a message into the nested type tree.
func insertMessage(node *TypeNode, path []string, msg *Message) {
	if len(path) == 0 {
		return
	}

	name := path[0]
	if node.Children == nil {
		node.Children = make(map[string]*TypeNode)
	}

	child, exists := node.Children[name]
	if !exists {
		child = &TypeNode{Name: name, Children: make(map[string]*TypeNode)}
		node.Children[name] = child
	}

	if len(path) == 1 {
		child.Message = msg
	} else {
		insertMessage(child, path[1:], msg)
	}
}

// insertEnum inserts an enum into the nested type tree.
func insertEnum(node *TypeNode, path []string, enum *Enum) {
	if len(path) == 0 {
		return
	}

	name := path[0]
	if node.Children == nil {
		node.Children = make(map[string]*TypeNode)
	}

	child, exists := node.Children[name]
	if !exists {
		child = &TypeNode{Name: name, Children: make(map[string]*TypeNode)}
		node.Children[name] = child
	}

	if len(path) == 1 {
		child.Enum = enum
	} else {
		insertEnum(child, path[1:], enum)
	}
}

// writeTypeTree emits nested messages and enums in stable name order.
func writeTypeTree(node *TypeNode, sb *strings.Builder, resolver *TypeResolver, indent int, currentPkg string) {
	// Sort child nodes for stable output.
	var names []string
	for name := range node.Children {
		names = append(names, name)
	}
	sort.Strings(names)

	indentStr := strings.Repeat("  ", indent)

	for _, name := range names {
		child := node.Children[name]

		if child.Enum != nil {
			// Check whether the enum comes from another package.
			originalType := ""
			if copied := copiedTypes[currentPkg]; copied != nil {
				if orig, ok := copied[child.Enum.ShortName]; ok {
					originalType = orig
				}
			}

			// Write the enum origin comment.
			if originalType != "" {
				sb.WriteString(fmt.Sprintf("%s// Copied from: %s (var: %s)\n", indentStr, originalType, child.Enum.VarName))
			} else {
				sb.WriteString(fmt.Sprintf("%s// Source: %s (var: %s)\n", indentStr, child.Enum.TypeName, child.Enum.VarName))
			}
			// Write the enum declaration.
			sb.WriteString(fmt.Sprintf("%senum %s {\n", indentStr, name))
			for _, v := range child.Enum.Values {
				sb.WriteString(fmt.Sprintf("%s  %s = %d;\n", indentStr, v.Name, v.No))
			}
			sb.WriteString(fmt.Sprintf("%s}\n\n", indentStr))
		} else if child.Message != nil || len(child.Children) > 0 {
			// Write the message origin comment.
			if child.Message != nil {
				varInfo := child.Message.VarName
				if child.Message.InternalName != "" && child.Message.InternalName != child.Message.VarName {
					varInfo = fmt.Sprintf("%s, class: %s", child.Message.VarName, child.Message.InternalName)
				}

				// Check whether the message comes from another package.
				originalType := ""
				if copied := copiedTypes[currentPkg]; copied != nil {
					if orig, ok := copied[child.Message.ShortName]; ok {
						originalType = orig
					}
				}

				if originalType != "" {
					sb.WriteString(fmt.Sprintf("%s// Copied from: %s (var: %s)\n", indentStr, originalType, varInfo))
				} else {
					sb.WriteString(fmt.Sprintf("%s// Source: %s (var: %s)\n", indentStr, child.Message.TypeName, varInfo))
				}
			}
			// Write the message container even when the node only carries nested types.
			sb.WriteString(fmt.Sprintf("%smessage %s {\n", indentStr, name))

			// Write nested types first.
			writeTypeTree(child, sb, resolver, indent+1, currentPkg)

			// Write fields only when the current node has a message declaration.
			if child.Message != nil {
				writeMessageFields(child.Message, sb, resolver, indent+1)
			}

			sb.WriteString(fmt.Sprintf("%s}\n\n", indentStr))
		}
	}
}

// writeMessageFields emits plain fields and oneof groups.
func writeMessageFields(msg *Message, sb *strings.Builder, resolver *TypeResolver, indent int) {
	indentStr := strings.Repeat("  ", indent)

	// Get the current message path for resolving relative nested types.
	msgPath := msg.ShortName
	currentPkg := msg.Package
	preferredPkg, _ := parseTypeName(msg.TypeName)

	// Group fields by oneof.
	oneofGroups := make(map[string][]Field)
	var regularFields []Field

	for _, f := range msg.Fields {
		if f.Oneof != "" {
			oneofGroups[f.Oneof] = append(oneofGroups[f.Oneof], f)
		} else {
			regularFields = append(regularFields, f)
		}
	}

	// Write plain fields first.
	for _, f := range regularFields {
		fieldType := resolveFieldTypeWithPkg(f, resolver, msgPath, currentPkg, preferredPkg, msg.Pos, msg.ModuleStart)
		prefix := ""
		if f.Repeated {
			prefix = "repeated "
		} else if f.Opt {
			prefix = "optional "
		}
		sb.WriteString(fmt.Sprintf("%s%s%s %s = %d;\n", indentStr, prefix, fieldType, f.Name, f.No))
	}

	// Then write the oneof field groups.
	var oneofNames []string
	for name := range oneofGroups {
		oneofNames = append(oneofNames, name)
	}
	sort.Strings(oneofNames)

	for _, oneofName := range oneofNames {
		fields := oneofGroups[oneofName]
		sb.WriteString(fmt.Sprintf("%soneof %s {\n", indentStr, oneofName))
		for _, f := range fields {
			fieldType := resolveFieldTypeWithPkg(f, resolver, msgPath, currentPkg, preferredPkg, msg.Pos, msg.ModuleStart)
			sb.WriteString(fmt.Sprintf("%s  %s %s = %d;\n", indentStr, fieldType, f.Name, f.No))
		}
		sb.WriteString(fmt.Sprintf("%s}\n", indentStr))
	}
}

// parseTypeName splits a fully qualified type name into protocol package and full nested path.
func parseTypeName(typeName string) (pkg, shortName string) {
	// Prefer the versioned protocol package form xxx.vN.Rest.
	versionRe := regexp.MustCompile(`^([\w.]+\.v\d+)\.(.+)$`)
	if match := versionRe.FindStringSubmatch(typeName); match != nil {
		return match[1], match[2]
	}

	// Handle google.protobuf standard types separately.
	if strings.HasPrefix(typeName, "google.protobuf.") {
		rest := strings.TrimPrefix(typeName, "google.protobuf.")
		return "google.protobuf", rest
	}

	// Handle google.rpc standard types separately.
	if strings.HasPrefix(typeName, "google.rpc.") {
		rest := strings.TrimPrefix(typeName, "google.rpc.")
		return "google.rpc", rest
	}

	// When the package version is unrecognized, fall back to splitting at the last dot.
	parts := strings.Split(typeName, ".")
	if len(parts) > 1 {
		return strings.Join(parts[:len(parts)-1], "."), parts[len(parts)-1]
	}
	return "", typeName
}

// getNestedPath splits a nested type name into its per-level path.
func getNestedPath(shortName string) []string {
	return strings.Split(shortName, ".")
}

// resolveFieldTypeWithPkg resolves a field type using the current package and parent message path.
func resolveFieldTypeWithPkg(f Field, resolver *TypeResolver, parentPath string, currentPkg string, preferredPkg string, contextPos int, contextModuleStart int) string {
	resolveNamedType := func(ref string, expectedKind string) string {
		typeName, ok := resolver.ResolveTypeName(ref, contextPos, contextModuleStart, preferredPkg, expectedKind)
		if !ok {
			activeDiagnostics.addUnresolvedType(expectedKind + ":" + ref)
			return fallbackTypeToken(ref)
		}

		refPkg, shortName := parseTypeName(typeName)

		// Use a relative path when the type lives under the same parent message.
		if parentPath != "" && strings.HasPrefix(shortName, parentPath+".") {
			// e.g. ConversationMessage.CodeChunk shortens to CodeChunk inside the message.
			return strings.TrimPrefix(shortName, parentPath+".")
		}

		// Same-package types use the short name only.
		if refPkg == currentPkg || refPkg == "" {
			return shortName
		}

		// In cyclic dependencies prefer types already copied into the current package.
		if copied := copiedTypes[currentPkg]; copied != nil {
			if _, isCopied := copied[shortName]; isCopied {
				// Use the short name when a copied type exists locally.
				return shortName
			}
		}

		// Other cross-package references keep the fully qualified name.
		return refPkg + "." + shortName
	}

	if f.Kind == "scalar" {
		if t, ok := f.T.(int); ok {
			return scalarTypes[t]
		}
		if t, ok := f.T.(float64); ok {
			return scalarTypes[int(t)]
		}
	}

	if f.Kind == "message" || f.Kind == "enum" {
		if ref, ok := f.T.(string); ok {
			return resolveNamedType(ref, f.Kind)
		}
	}

	if f.Kind == "map" {
		// map fields resolve key and value types separately.
		keyType := scalarTypes[f.MapKey]
		if keyType == "" {
			keyType = "string" // Unknown scalars default to string.
		}

		var valueType string
		if f.MapValueKind == "scalar" {
			if t, ok := f.MapValueT.(int); ok {
				valueType = scalarTypes[t]
			} else if t, ok := f.MapValueT.(float64); ok {
				valueType = scalarTypes[int(t)]
			}
		} else if f.MapValueKind == "message" || f.MapValueKind == "enum" {
			if ref, ok := f.MapValueT.(string); ok {
				valueType = resolveNamedType(ref, f.MapValueKind)
			}
		}
		if valueType == "" {
			valueType = "bytes"
		}

		return fmt.Sprintf("map<%s, %s>", keyType, valueType)
	}

	return "bytes" // Unrecognized field types fall back to bytes.
}
