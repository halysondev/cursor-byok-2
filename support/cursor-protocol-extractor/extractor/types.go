// types.go defines the protocol extractor's domain structs, diagnostic state, and base type mappings.
package main

import (
	"fmt"
	"regexp"
	"strings"
)

// isGooglePkg reports whether the package is a Google standard package that does not need regeneration.
func isGooglePkg(pkg string) bool {
	return pkg == "google.protobuf" || pkg == "google.rpc"
}

// scalarTypes maps runtime scalar numbers to proto types.
var scalarTypes = map[int]string{
	1:  "double",
	2:  "float",
	3:  "int64",
	4:  "uint64",
	5:  "int32",
	6:  "fixed64",
	7:  "fixed32",
	8:  "bool",
	9:  "string",
	12: "bytes",
	13: "uint32",
	15: "sfixed32",
	16: "sfixed64",
	17: "sint32",
	18: "sint64",
}

// strictExtractionValidation controls whether a validation failure aborts extraction.
var strictExtractionValidation = true

// extractionDiagnostics aggregates field-parsing and type-resolution diagnostics.
type extractionDiagnostics struct {
	totalFieldObjects   int
	parsedFieldObjects  int
	skippedFieldObjects int
	skippedFieldSamples []string
	unresolvedTypeRefs  map[string]int
	emptyMessages       []string
	placeholderHits     []string
	declaredTypes       int
	extractedTypes      int
	missingDeclarations []string
}

// newExtractionDiagnostics creates a diagnostics container for one extraction run.
func newExtractionDiagnostics() *extractionDiagnostics {
	return &extractionDiagnostics{
		unresolvedTypeRefs: make(map[string]int),
	}
}

// addSkippedField records a field sample that failed to parse and the reason.
func (d *extractionDiagnostics) addSkippedField(fieldObject string, reason error) {
	if d == nil {
		return
	}
	d.totalFieldObjects++
	d.skippedFieldObjects++
	if len(d.skippedFieldSamples) < 20 {
		trimmed := strings.TrimSpace(fieldObject)
		if len(trimmed) > 140 {
			trimmed = trimmed[:140] + "..."
		}
		if reason != nil {
			d.skippedFieldSamples = append(d.skippedFieldSamples, fmt.Sprintf("%s | %s", reason.Error(), trimmed))
		} else {
			d.skippedFieldSamples = append(d.skippedFieldSamples, trimmed)
		}
	}
}

// addParsedField accumulates the number of successfully parsed fields.
func (d *extractionDiagnostics) addParsedField() {
	if d == nil {
		return
	}
	d.totalFieldObjects++
	d.parsedFieldObjects++
}

// addUnresolvedType accumulates type-resolution failures by reference name.
func (d *extractionDiagnostics) addUnresolvedType(ref string) {
	if d == nil {
		return
	}
	key := strings.TrimSpace(ref)
	if key == "" {
		key = "<empty>"
	}
	d.unresolvedTypeRefs[key]++
}

// SetStrictMode sets whether a validation failure aborts extraction.
func SetStrictMode(enabled bool) {
	strictExtractionValidation = enabled
}

// activeDiagnostics points at the current extraction run's diagnostic state.
var activeDiagnostics *extractionDiagnostics

// Field-parsing regexes cover the declaration forms found in minified bundles.
var (
	noRe                    = regexp.MustCompile(`(?:^|[,{]\s*)no:\s*(\d+)`)
	nameRe                  = regexp.MustCompile(`(?:^|[,{]\s*)name:\s*["']([^"']+)["']`)
	kindRe                  = regexp.MustCompile(`(?:^|[,{]\s*)kind:\s*["']([^"']+)["']`)
	enumTypeRe              = regexp.MustCompile(`[,\s]T:\s*[\w$.]+\.getEnumType\s*\(\s*([\w$.]+)\s*\)`)
	tRe                     = regexp.MustCompile(`[,\s]T:\s*([\w$.]+)`)
	oneofRe                 = regexp.MustCompile(`oneof:\s*["']([^"']+)["']`)
	repeatedRe              = regexp.MustCompile(`repeated:\s*(!0|true)`)
	optRe                   = regexp.MustCompile(`opt:\s*(!0|true)`)
	keyRe                   = regexp.MustCompile(`[,\s]K:\s*(\d+)`)
	mapValueRe              = regexp.MustCompile(`V:\s*\{([^}]*)\}`)
	mapValueKRe             = regexp.MustCompile(`(?:^|[,{]\s*)kind:\s*["'](\w+)["']`)
	mapValueTRe             = regexp.MustCompile(`[,\s]T:\s*([\w$.]+)`)
	shorthandTRe            = regexp.MustCompile(`(?:^|[,\{])\s*T\s*(?:[,\}])`)
	oneofNameRe             = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
	fieldNameRe             = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)
	placeholderRe           = regexp.MustCompile(`^\s*(optional\s+|repeated\s+)?[A-Za-z_][A-Za-z0-9_.<>]*\s+(field_\d+|unknown(?:_[A-Za-z0-9_]+)?)\s*=\s*\d+\s*;`)
	varAliasRe              = regexp.MustCompile(`\b(?:let|const|var)\s+([\w$]+)\s*=\s*([\w$]+)\s*(?:[,;])`)
	assignmentAliasRe       = regexp.MustCompile(`(?:^|[;,({])\s*([\w$]+)\s*=\s*([\w$]+)\s*([,;}])`)
	webpackExportBlockRe    = regexp.MustCompile(`[\w$]+\.d\(\s*[\w$]+\s*,\s*\{`)
	webpackExportEntryRe    = regexp.MustCompile(`(?:^|[,\{])\s*([\w$]+)\s*:\s*\(\s*\)\s*=>\s*([\w$]+)`)
	moduleImportRe          = regexp.MustCompile(`(?:\b(?:var|let|const)\s+|,)\s*([\w$]+)\s*=\s*[\w$]+\(\s*(\d+)\s*\)`)
	typeNameDeclarationRe   = regexp.MustCompile(`(?:\bthis|[\w$]+)\.typeName\s*=\s*["']([\w.]+)["']`)
	serviceDeclarationRe    = regexp.MustCompile(`\{\s*typeName\s*:\s*["']([\w.]+)["']\s*,\s*methods\s*:`)
	messageDeclarationRe    = regexp.MustCompile(`\.makeMessageType\s*\(\s*["']([\w.]+)["']`)
	enumDeclarationRe       = regexp.MustCompile(`\.makeEnum\s*\(\s*["']([\w.]+)["']`)
	legacyEnumDeclarationRe = regexp.MustCompile(`\.setEnumType\s*\(\s*[\w$]+\s*,\s*["']([\w.]+)["']`)
	streamCloseRe           = regexp.MustCompile(`(?s)message\s+ExecClientControlMessage\s*\{.*?ExecClientStreamClose\s+stream_close\s*=\s*1\s*;`)
	shellStdoutRe           = regexp.MustCompile(`(?s)message\s+ShellStream\s*\{.*?ShellStreamStdout\s+stdout\s*=\s*1\s*;`)
)

// Field describes a protobuf field to render.
type Field struct {
	// No is the field number.
	No int `json:"no"`
	// Name is the field name.
	Name string `json:"name"`
	// Kind is the scalar, message, enum, or map kind.
	Kind string `json:"kind"`
	// T holds a scalar number or a message reference variable.
	T any `json:"T"`
	// Oneof is the mutually exclusive group the field belongs to.
	Oneof string `json:"oneof"`
	// Repeated marks the field as repeatable.
	Repeated bool `json:"repeated"`
	// Opt marks the field as explicitly optional.
	Opt bool `json:"opt"`
	// MapKey is the map key's scalar number.
	MapKey int `json:"K"`
	// MapValueKind is the map value's scalar or message kind.
	MapValueKind string
	// MapValueT holds the map value's scalar number or message reference.
	MapValueT any
}

// Message describes an extracted message and its source position.
type Message struct {
	// TypeName is the message's fully qualified type name.
	TypeName string
	// VarName is the JS outer variable name.
	VarName string
	// InternalName is the JS inner class name.
	InternalName string
	// Fields is the message field list.
	Fields []Field
	// Package is the protocol package the message belongs to.
	Package string
	// ShortName is the nested type name within the package.
	ShortName string
	// Pos is the message's byte position in the bundle.
	Pos int
	// ModuleStart is the start position of the module containing the message.
	ModuleStart int
}

// Enum describes an extracted enum and its source position.
type Enum struct {
	// TypeName is the enum's fully qualified type name.
	TypeName string
	// VarName is the enum's JS variable name.
	VarName string
	// Values is the enum value list.
	Values []EnumValue
	// Package is the protocol package the enum belongs to.
	Package string
	// ShortName is the nested type name within the package.
	ShortName string
	// Pos is the enum's byte position in the bundle.
	Pos int
	// ModuleStart is the start position of the module containing the enum.
	ModuleStart int
}

// EnumValue describes a single enum number and name.
type EnumValue struct {
	// No is the enum number.
	No int
	// Name is the enum name.
	Name string
}

// Service describes an extracted service and its source position.
type Service struct {
	// TypeName is the service's fully qualified type name.
	TypeName string
	// VarName is the service's JS variable name.
	VarName string
	// Methods is the service method list.
	Methods []Method
	// Package is the protocol package the service belongs to.
	Package string
	// ShortName is the service's name within the package.
	ShortName string
	// Pos is the service's byte position in the bundle.
	Pos int
	// ModuleStart is the start position of the module containing the service.
	ModuleStart int
}

// Method describes an RPC method's input, output, and streaming mode.
type Method struct {
	// Name is the RPC method name.
	Name string
	// InputType is the input message reference variable.
	InputType string
	// OutputType is the output message reference variable.
	OutputType string
	// Kind is unary or a directional streaming call type.
	Kind string
}

// symbolDef holds a symbol's type, kind, and module position.
type symbolDef struct {
	// TypeName is the symbol's fully qualified type name.
	TypeName string
	// Pos is the symbol definition position.
	Pos int
	// Kind is the message or enum kind.
	Kind string
	// ModuleStart is the start of the module containing the symbol.
	ModuleStart int
}

// TypeResolver resolves protocol types through local symbols, aliases, and short names.
type TypeResolver struct {
	bySymbol      map[string][]symbolDef
	byAlias       map[string][]symbolDef
	byShort       map[string][]symbolDef
	moduleImports map[int]map[string]int
}

// aliasIndex stores alias sets keyed by module and target symbol.
type aliasIndex map[int]map[string][]string
