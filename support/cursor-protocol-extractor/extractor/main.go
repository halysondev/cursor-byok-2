// main.go provides argument parsing, input protection, and output scheduling for the protocol extraction command.
package main

import (
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
)

// inputPaths accepts repeated bundle paths on the command line.
type inputPaths []string

// String returns the registered input paths.
func (paths *inputPaths) String() string {
	return fmt.Sprint([]string(*paths))
}

// Set appends a whitespace-trimmed input path.
func (paths *inputPaths) Set(value string) error {
	*paths = append(*paths, value)
	return nil
}

// bailIf prints the message and exits on unrecoverable errors.
func bailIf(err error) {
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

// findPrettier locates a usable prettier command.
func findPrettier() (string, error) {
	// Try common prettier command names
	names := []string{"prettier", "prettier.cmd", "npx"}
	for _, name := range names {
		if path, err := exec.LookPath(name); err == nil {
			return path, nil
		}
	}
	return "", fmt.Errorf("prettier not found in PATH, please install: npm install -g prettier")
}

// main parses arguments, protects the original input, and runs the protocol extraction.
func main() {
	// Command-line arguments
	var inputs inputPaths
	flag.Var(&inputs, "input", "Path to a JS bundle; repeat to merge multiple bundles")
	outputDir := flag.String("output", "", "Output directory for proto files (required; use scripts/extract.sh for the repository source)")
	skipFormat := flag.Bool("skip-format", false, "Skip prettier formatting")
	strict := flag.Bool("strict", true, "Fail when extraction validation detects unresolved/placeholder output")
	flag.Parse()

	// If no -input flag was given, fall back to positional arguments
	if len(inputs) == 0 && flag.NArg() > 0 {
		inputs = append(inputs, flag.Args()...)
	}

	if len(inputs) == 0 {
		fmt.Fprintln(os.Stderr, "Usage: ext -input <path-to-js-file> [-input <another-js-file>] [-output <dir>] [-skip-format]")
		fmt.Fprintln(os.Stderr, "       ext <path-to-js-file>")
		fmt.Fprintln(os.Stderr, "\nExample:")
		fmt.Fprintln(os.Stderr, "  ext -input /path/to/extensionHostProcess.js")
		fmt.Fprintln(os.Stderr, "  ext C:\\Users\\xxx\\AppData\\Local\\Programs\\cursor\\resources\\app\\out\\vs\\workbench\\api\\node\\extensionHostProcess.js")
		os.Exit(1)
	}

	for _, inputPath := range inputs {
		info, err := os.Stat(inputPath)
		bailIf(err)
		if info.IsDir() {
			bailIf(fmt.Errorf("expected %s to be file, is dir", inputPath))
		}
	}

	// Require the caller to pick the output directory explicitly, so the repo does not gain a second protocol source.
	if *outputDir == "" {
		bailIf(fmt.Errorf("-output is required; use scripts/extract.sh to update protocols/cursor"))
	}

	// Copy to a temp file before formatting so the Cursor install directory is never modified.
	fmt.Printf("Copying %d source bundle(s) to temp directory...\n", len(inputs))
	tempFileNames := make([]string, 0, len(inputs))
	for _, inputPath := range inputs {
		originalFile, err := os.Open(inputPath)
		bailIf(err)
		tempFile, err := os.CreateTemp(os.TempDir(), "cursor-source-*.js")
		bailIf(err)
		_, err = io.Copy(tempFile, originalFile)
		bailIf(err)
		bailIf(originalFile.Close())
		bailIf(tempFile.Close())
		tempFileNames = append(tempFileNames, tempFile.Name())
		fmt.Printf("Source: %s\n", inputPath)
	}

	if *skipFormat {
		fmt.Println("Skipping formatting (--skip-format)")
	} else if prettierBin, err := findPrettier(); err != nil {
		fmt.Printf("Warning: %v\n", err)
		fmt.Println("Skipping formatting, extraction may be less accurate...")
	} else {
		fmt.Println("Formatting source bundles (this may take a while)...")
		for _, tempFileName := range tempFileNames {
			var prettierCmd *exec.Cmd
			if filepath.Base(prettierBin) == "npx" {
				prettierCmd = exec.Command(prettierBin, "prettier", "--write", tempFileName)
			} else {
				prettierCmd = exec.Command(prettierBin, "--write", tempFileName)
			}
			out, formatErr := prettierCmd.CombinedOutput()
			if formatErr != nil {
				fmt.Printf("Prettier output: %s\n", string(out))
				fmt.Println("Warning: formatting failed for one bundle, continuing anyway...")
			}
		}
	}

	// Run the extractor
	fmt.Println("Extracting Proto definitions...")
	SetStrictMode(*strict)
	ExtractProtosFromFiles(tempFileNames, *outputDir)

	for _, tempFileName := range tempFileNames {
		_ = os.Remove(tempFileName)
	}

	fmt.Printf("\nOutput directory: %s\n", *outputDir)
}
