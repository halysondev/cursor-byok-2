// modules.go scans module boundaries, merges declarations, and validates extraction results.
package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/jhump/protoreflect/desc"
	"github.com/jhump/protoreflect/desc/protoparse"
)

// moduleStartRe matches the function start of a Webpack numbered module.
var moduleStartRe = regexp.MustCompile(`(?:^|,)\s*(\d+)\s*:\s*(?:function\s*\(\s*[\w$,\s]*\s*\)|\(\s*[\w$,\s]*\s*\)\s*=>)\s*\{`)

// buildModuleStarts collects every module start position in the bundle.
func buildModuleStarts(text string) []int {
	matches := moduleStartRe.FindAllStringSubmatchIndex(text, -1)
	starts := make([]int, 0, len(matches))
	for _, match := range matches {
		starts = append(starts, match[0])
	}
	return starts
}

// moduleStartForPos finds the module start owning a given source position.
func moduleStartForPos(moduleStarts []int, pos int) int {
	if len(moduleStarts) == 0 {
		return 0
	}
	index := sort.Search(len(moduleStarts), func(i int) bool {
		return moduleStarts[i] > pos
	}) - 1
	if index < 0 {
		return 0
	}
	return moduleStarts[index]
}

// buildModuleImportIndex maps module-local variables to imported module numbers.
func buildModuleImportIndex(text string, moduleStarts []int) map[int]map[string]int {
	if len(moduleStarts) == 0 {
		return nil
	}

	moduleMatches := moduleStartRe.FindAllStringSubmatchIndex(text, -1)
	moduleStartByID := make(map[string]int, len(moduleMatches))
	for _, match := range moduleMatches {
		moduleStartByID[text[match[2]:match[3]]] = match[0]
	}

	importsByModule := make(map[int]map[string]int)
	for index, moduleStart := range moduleStarts {
		moduleEnd := len(text)
		if index+1 < len(moduleStarts) {
			moduleEnd = moduleStarts[index+1]
		}
		body := text[moduleStart:moduleEnd]
		for _, match := range moduleImportRe.FindAllStringSubmatch(body, -1) {
			targetModuleStart, ok := moduleStartByID[match[2]]
			if !ok {
				continue
			}
			if importsByModule[moduleStart] == nil {
				importsByModule[moduleStart] = make(map[string]int)
			}
			importsByModule[moduleStart][match[1]] = targetModuleStart
		}
	}
	return importsByModule
}

// ExtractProtosFromFiles extracts each bundle separately, normalizes type references, and merges by fully qualified name.
// When multiple bundles declare the same name, the earlier input wins.
func ExtractProtosFromFiles(inputFiles []string, outputDir string) {
	activeDiagnostics = newExtractionDiagnostics()
	defer func() {
		activeDiagnostics = nil
	}()

	var allMessages []Message
	var allEnums []Enum
	var allServices []Service
	for _, inputFile := range inputFiles {
		content, err := os.ReadFile(inputFile)
		if err != nil {
			fmt.Fprintf(os.Stderr, "Error reading file %s: %v\n", inputFile, err)
			os.Exit(1)
		}

		text := string(content)
		moduleStarts := buildModuleStarts(text)
		aliases := buildAliasIndex(text, moduleStarts)
		exportAliases := buildWebpackExportAliasIndex(text, moduleStarts)

		messages := extractMessages(text, moduleStarts)
		enums := extractEnums(text, moduleStarts)
		services := extractServices(text, moduleStarts)
		declared, extracted, missing := declarationCoverage(text, messages, enums, services)
		activeDiagnostics.declaredTypes += declared
		activeDiagnostics.extractedTypes += extracted
		activeDiagnostics.missingDeclarations = append(activeDiagnostics.missingDeclarations, missing...)

		resolver := newTypeResolver(messages, enums, aliases, exportAliases)
		resolver.moduleImports = buildModuleImportIndex(text, moduleStarts)
		normalizeTypeReferences(messages, services, resolver)

		allMessages = append(allMessages, messages...)
		allEnums = append(allEnums, enums...)
		allServices = append(allServices, services...)
	}

	messages := mergeMessagesByTypeName(allMessages)
	enums := mergeEnumsByTypeName(allEnums)
	services := mergeServicesByTypeName(allServices)
	for _, msg := range messages {
		if len(msg.Fields) == 0 {
			activeDiagnostics.emptyMessages = append(activeDiagnostics.emptyMessages, msg.TypeName)
		}
	}
	sort.Strings(activeDiagnostics.missingDeclarations)
	activeDiagnostics.missingDeclarations = compactStrings(activeDiagnostics.missingDeclarations)

	resolver := newTypeResolver(messages, enums, nil, nil)

	generateProtos(messages, enums, services, resolver, outputDir)

	validateErr := validateGeneratedProtos(outputDir, activeDiagnostics)

	printDiagnosticsSummary(activeDiagnostics)

	if strictExtractionValidation && hasValidationFailure(activeDiagnostics, validateErr) {
		if validateErr != nil {
			fmt.Fprintf(os.Stderr, "Validation failed: %v\n", validateErr)
		}
		os.Exit(1)
	}

	if validateErr != nil {
		fmt.Fprintf(os.Stderr, "Validation warning: %v\n", validateErr)
	}

	fmt.Printf("Extraction complete: %d messages, %d enums, %d services\n", len(messages), len(enums), len(services))
}

// normalizeTypeReferences converts field and method references into fully qualified type names.
func normalizeTypeReferences(messages []Message, services []Service, resolver *TypeResolver) {
	resolve := func(ref any, contextPos int, moduleStart int, pkg string, kind string) any {
		symbol, ok := ref.(string)
		if !ok || strings.TrimSpace(symbol) == "" {
			return ref
		}
		if typeName, resolved := resolver.ResolveTypeName(symbol, contextPos, moduleStart, pkg, kind); resolved {
			return typeName
		}
		return ref
	}

	for messageIndex := range messages {
		message := &messages[messageIndex]
		for fieldIndex := range message.Fields {
			field := &message.Fields[fieldIndex]
			if field.Kind == "message" || field.Kind == "enum" {
				field.T = resolve(field.T, message.Pos, message.ModuleStart, message.Package, field.Kind)
			}
			if field.Kind == "map" && (field.MapValueKind == "message" || field.MapValueKind == "enum") {
				field.MapValueT = resolve(field.MapValueT, message.Pos, message.ModuleStart, message.Package, field.MapValueKind)
			}
		}
	}

	for serviceIndex := range services {
		service := &services[serviceIndex]
		for methodIndex := range service.Methods {
			method := &service.Methods[methodIndex]
			if typeName, ok := resolve(method.InputType, service.Pos, service.ModuleStart, service.Package, "message").(string); ok {
				method.InputType = typeName
			}
			if typeName, ok := resolve(method.OutputType, service.Pos, service.ModuleStart, service.Package, "message").(string); ok {
				method.OutputType = typeName
			}
		}
	}
}

// mergeMessagesByTypeName merges messages by fully qualified name, keeping the first declaration.
func mergeMessagesByTypeName(messages []Message) []Message {
	seen := make(map[string]bool)
	merged := make([]Message, 0, len(messages))
	for _, message := range messages {
		if seen[message.TypeName] {
			continue
		}
		seen[message.TypeName] = true
		merged = append(merged, message)
	}
	return merged
}

// mergeEnumsByTypeName merges enums by fully qualified name, keeping the first declaration.
func mergeEnumsByTypeName(enums []Enum) []Enum {
	seen := make(map[string]bool)
	merged := make([]Enum, 0, len(enums))
	for _, enum := range enums {
		if seen[enum.TypeName] {
			continue
		}
		seen[enum.TypeName] = true
		merged = append(merged, enum)
	}
	return merged
}

// mergeServicesByTypeName merges services by fully qualified name, keeping the first declaration.
func mergeServicesByTypeName(services []Service) []Service {
	seen := make(map[string]bool)
	merged := make([]Service, 0, len(services))
	for _, service := range services {
		if seen[service.TypeName] {
			continue
		}
		seen[service.TypeName] = true
		merged = append(merged, service)
	}
	return merged
}

// compactStrings cleans, deduplicates, and sorts diagnostic strings.
func compactStrings(values []string) []string {
	if len(values) == 0 {
		return nil
	}
	compacted := values[:1]
	for _, value := range values[1:] {
		if value != compacted[len(compacted)-1] {
			compacted = append(compacted, value)
		}
	}
	return compacted
}

// hasValidationFailure reports whether diagnostics meet the failure condition.
func hasValidationFailure(diag *extractionDiagnostics, validateErr error) bool {
	if validateErr != nil {
		return true
	}
	if diag == nil {
		return false
	}
	if diag.skippedFieldObjects > 0 {
		return true
	}
	if len(diag.unresolvedTypeRefs) > 0 {
		return true
	}
	if len(diag.placeholderHits) > 0 {
		return true
	}
	if len(diag.missingDeclarations) > 0 {
		return true
	}
	return false
}

// printDiagnosticsSummary prints an extraction coverage and anomaly-sample summary.
func printDiagnosticsSummary(diag *extractionDiagnostics) {
	if diag == nil {
		return
	}

	fmt.Printf(
		"Diagnostics: fields %d/%d parsed, declarations %d/%d extracted, skipped=%d, unresolved=%d, placeholders=%d, empty_messages=%d\n",
		diag.parsedFieldObjects,
		diag.totalFieldObjects,
		diag.extractedTypes,
		diag.declaredTypes,
		diag.skippedFieldObjects,
		len(diag.unresolvedTypeRefs),
		len(diag.placeholderHits),
		len(diag.emptyMessages),
	)

	if diag.skippedFieldObjects > 0 && len(diag.skippedFieldSamples) > 0 {
		fmt.Println("Field parse failure samples:")
		for _, sample := range diag.skippedFieldSamples {
			fmt.Printf("  - %s\n", sample)
		}
	}

	if len(diag.unresolvedTypeRefs) > 0 {
		keys := make([]string, 0, len(diag.unresolvedTypeRefs))
		for key := range diag.unresolvedTypeRefs {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		fmt.Println("Unresolved type references:")
		for _, key := range keys {
			fmt.Printf("  - %s (%d)\n", key, diag.unresolvedTypeRefs[key])
		}
	}

	if len(diag.placeholderHits) > 0 {
		fmt.Println("Placeholder field hits:")
		for i, hit := range diag.placeholderHits {
			if i >= 20 {
				fmt.Printf("  - ... and %d more\n", len(diag.placeholderHits)-20)
				break
			}
			fmt.Printf("  - %s\n", hit)
		}
	}

	if len(diag.missingDeclarations) > 0 {
		fmt.Println("Unextracted proto declarations:")
		for i, typeName := range diag.missingDeclarations {
			if i >= 20 {
				fmt.Printf("  - ... and %d more\n", len(diag.missingDeclarations)-20)
				break
			}
			fmt.Printf("  - %s\n", typeName)
		}
	}
}

// declarationCoverage compares the bundle's declaration count against what was actually extracted.
func declarationCoverage(text string, messages []Message, enums []Enum, services []Service) (int, int, []string) {
	declared := make(map[string]bool)
	collect := func(re *regexp.Regexp) {
		for _, match := range re.FindAllStringSubmatch(text, -1) {
			typeName := strings.TrimSpace(match[1])
			pkg, _ := parseTypeName(typeName)
			if typeName != "" && !isGooglePkg(pkg) {
				declared[typeName] = true
			}
		}
	}
	collect(typeNameDeclarationRe)
	collect(serviceDeclarationRe)
	collect(messageDeclarationRe)
	collect(enumDeclarationRe)
	collect(legacyEnumDeclarationRe)

	extracted := make(map[string]bool)
	for _, message := range messages {
		extracted[message.TypeName] = true
	}
	for _, enum := range enums {
		extracted[enum.TypeName] = true
	}
	for _, service := range services {
		extracted[service.TypeName] = true
	}

	matched := 0
	missing := make([]string, 0)
	for typeName := range declared {
		if extracted[typeName] {
			matched++
			continue
		}
		missing = append(missing, typeName)
	}
	sort.Strings(missing)
	return len(declared), matched, missing
}

// validateGeneratedProtos checks generated files for syntax placeholders and key Agent structures.
func validateGeneratedProtos(outputDir string, diag *extractionDiagnostics) error {
	entries, err := os.ReadDir(outputDir)
	if err != nil {
		return fmt.Errorf("read output dir failed: %w", err)
	}

	protoFiles := make([]string, 0, len(entries))
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()
		if strings.HasSuffix(name, ".proto") {
			protoFiles = append(protoFiles, name)
		}
	}
	if len(protoFiles) == 0 {
		return errors.New("no generated proto files found")
	}
	sort.Strings(protoFiles)

	for _, file := range protoFiles {
		body, readErr := os.ReadFile(filepath.Join(outputDir, file))
		if readErr != nil {
			return fmt.Errorf("read generated proto failed: %s: %w", file, readErr)
		}
		lines := strings.Split(string(body), "\n")
		for idx, line := range lines {
			if placeholderRe.MatchString(line) && diag != nil {
				hit := fmt.Sprintf("%s:%d: %s", file, idx+1, strings.TrimSpace(line))
				diag.placeholderHits = append(diag.placeholderHits, hit)
			}
		}
		if err := validateRequiredAgentShapes(file, string(body)); err != nil {
			return err
		}
	}

	parser := protoparse.Parser{
		ImportPaths:  []string{outputDir},
		LookupImport: desc.LoadFileDescriptor,
	}
	if _, parseErr := parser.ParseFiles(protoFiles...); parseErr != nil {
		return fmt.Errorf("parse generated proto failed: %w", parseErr)
	}

	return nil
}

// validateRequiredAgentShapes validates the required field shapes of Agent flow-control messages.
func validateRequiredAgentShapes(file string, body string) error {
	if strings.Contains(body, "message ExecClientControlMessage") && !streamCloseRe.MatchString(body) {
		return fmt.Errorf("%s: ExecClientControlMessage.stream_close must be ExecClientStreamClose", file)
	}
	if strings.Contains(body, "message ShellStream") && !shellStdoutRe.MatchString(body) {
		return fmt.Errorf("%s: ShellStream.stdout must be ShellStreamStdout", file)
	}
	return nil
}
