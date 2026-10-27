# Optional project regeneration; normal Xcode builds use the checked-in project.
# Paths are rooted at this script, so it can run from any directory.
require 'xcodeproj'
root = File.expand_path('..', __dir__)
project_path = File.join(root, 'Asset.xcodeproj')
project = Xcodeproj::Project.new(project_path)
target = project.new_target(:application, 'Asset', :ios, '18.0')
group = project.main_group.new_group('Asset', 'Asset')
['', 'UI', 'Persistence'].each do |directory|
  source_group = directory.empty? ? group : group.new_group(directory, directory)
  Dir[File.join(root, 'Asset', directory, '*.swift')].sort.each do |path|
    target.source_build_phase.add_file_reference(source_group.new_file(File.basename(path)))
  end
end
resources = group.new_group('Resources', 'Resources')
['CalculationEngine.js', 'Lato-Regular.ttf', 'Lato-Medium.ttf', 'OFL.txt', 'third-party-notices.txt'].each do |name|
  target.resources_build_phase.add_file_reference(resources.new_file(name))
end
group.new_file('Info.plist')
group.new_file('Asset.entitlements')
target.resources_build_phase.add_file_reference(group.new_file('Assets.xcassets'))
package = project.new(Xcodeproj::Project::Object::XCRemoteSwiftPackageReference)
package.repositoryURL = 'https://github.com/plaid/plaid-link-ios-spm.git'
package.requirement = {'kind'=>'exactVersion', 'version'=>'7.2.2'}
project.root_object.package_references << package
product = project.new(Xcodeproj::Project::Object::XCSwiftPackageProductDependency)
product.package = package
product.product_name = 'LinkKit'
target.package_product_dependencies << product
build_file = project.new(Xcodeproj::Project::Object::PBXBuildFile)
build_file.product_ref = product
target.frameworks_build_phase.files << build_file
project.files.select { |file| File.basename(file.path.to_s) == 'Foundation.framework' }.each do |file|
  file.path = 'System/Library/Frameworks/Foundation.framework'
  file.source_tree = 'SDKROOT'
end
target.build_configurations.each do |config|
  config.build_settings.merge!({
    'PRODUCT_BUNDLE_IDENTIFIER'=>'org.gtfol.asset', 'SWIFT_VERSION'=>'5.0',
    'INFOPLIST_FILE'=>'Asset/Info.plist', 'GENERATE_INFOPLIST_FILE'=>'NO',
    'MARKETING_VERSION'=>'0.1.0', 'CURRENT_PROJECT_VERSION'=>'9',
    'TARGETED_DEVICE_FAMILY'=>'1,2', 'CODE_SIGN_STYLE'=>'Automatic',
    'DEVELOPMENT_TEAM'=>'J59ZSG67SJ',
    'CODE_SIGN_ENTITLEMENTS'=>'Asset/Asset.entitlements',
    'APS_ENVIRONMENT'=>(config.name == 'Release' ? 'production' : 'development'),
    'ENABLE_USER_SCRIPT_SANDBOXING'=>'YES',
    'ASSETCATALOG_COMPILER_APPICON_NAME'=>'AppIcon',
    'ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME'=>'AccentColor'
  })
end
project.predictabilize_uuids if project.respond_to?(:predictabilize_uuids)
project.save
scheme = Xcodeproj::XCScheme.new
scheme.add_build_target(target)
scheme.set_launch_target(target)
scheme.save_as(project_path, 'Asset', true)
